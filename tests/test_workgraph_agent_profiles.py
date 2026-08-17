import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
REPORTER = ROOT / ".github" / "mcp" / "workgraph-reporter.mjs"
VALIDATION_PROFILES = (
    ROOT / ".github" / "workgraph" / "profiles" / "issue-validation"
)
DOC = ROOT / "docs" / "workgraph-result-reporter.md"
README = ROOT / "README.md"
PROFILE_TASK_TYPES = {
    "issue-validator": "issue-validation",
    "issue-risk-profiler": "issue-risk-profile",
}
PROFILE_TOOLS = {
    "issue-validator": [
        "read",
        "github/issue_read",
        "workgraph/report_progress",
        "workgraph/submit_task_result",
    ],
    "issue-risk-profiler": [
        "github/issue_read",
        "workgraph/report_progress",
        "workgraph/submit_task_result",
    ],
}


class WorkGraphAgentProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profiles = {
            path.stem.removesuffix(".agent"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.reporter = REPORTER.read_text(encoding="utf-8")
        cls.validation_profiles = {
            path.stem: path.read_text(encoding="utf-8")
            for path in VALIDATION_PROFILES.glob("*.md")
        }
        cls.doc = DOC.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")

    def test_exactly_two_repository_defined_profiles_exist(self):
        self.assertEqual(set(self.profiles), set(PROFILE_TASK_TYPES))
        self.assertEqual(
            {path.name for path in AGENTS.glob("*.agent.md")},
            {
                "issue-validator.agent.md",
                "issue-risk-profiler.agent.md",
            },
        )

    def test_profiles_are_user_invocable_and_least_privileged(self):
        for name, profile in self.profiles.items():
            with self.subTest(profile=name):
                frontmatter = profile.split("---", 2)[1]
                self.assertRegex(frontmatter, rf"(?m)^name: {name}$")
                self.assertRegex(frontmatter, r"(?m)^description: \S")
                self.assertRegex(
                    frontmatter, r"(?m)^target: github-copilot$"
                )
                self.assertRegex(
                    frontmatter, r"(?m)^user-invocable: true$"
                )
                self.assertRegex(
                    frontmatter, r"(?m)^disable-model-invocation: true$"
                )
                tools = re.findall(r"(?m)^  - (\S+)$", frontmatter)
                self.assertEqual(tools, PROFILE_TOOLS[name])
                self.assertIn(
                    ".github/mcp/workgraph-reporter.mjs", frontmatter
                )
                for setting in [
                    "secrets.COPILOT_MCP_WORKGRAPH_TOKEN",
                    "vars.COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID",
                    "vars.COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID",
                    "vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID",
                ]:
                    self.assertIn(setting, frontmatter)
                self.assertNotIn("github/add_issue_comment", frontmatter)
                self.assertNotIn("github/issue_write", frontmatter)

    def test_profiles_follow_task_parent_work_result_flow(self):
        for name, task_type in PROFILE_TASK_TYPES.items():
            profile = self.profiles[name]
            with self.subTest(profile=name):
                self.assertIn("taskIssueNumber", profile)
                self.assertIn("taskIssueNodeId", profile)
                self.assertIn("method: get_parent", profile)
                self.assertIn("native parent relation is authoritative", profile)
                self.assertRegex(
                    profile,
                    rf'"assignmentId": "{task_type}:<parent node ID>"',
                )
                self.assertIn(
                    f'"taskType": "{task_type}"',
                    profile,
                )
                self.assertRegex(
                    profile,
                    r"Call `workgraph/submit_task_result` exactly once",
                )
                self.assertIn("never closes any Issue", profile)
                self.assertRegex(
                    profile, r"Never\s+write to the parent Issue"
                )

    def test_profiles_preserve_typed_work_contracts(self):
        validation = self.profiles["issue-validator"]
        self.assertIn("validationProfile", validation)
        self.assertIn("criteria", validation)
        self.assertIn('"criterion"', validation)
        self.assertIn('"passed"', validation)
        self.assertIn('"evidence"', validation)
        self.assertRegex(validation, r"Preserve each criterion string\s+exactly")

        risk = self.profiles["issue-risk-profiler"]
        self.assertIn("riskProfile", risk)
        self.assertIn("dimensions", risk)
        self.assertIn('"dimension"', risk)
        self.assertIn('"score"', risk)
        self.assertIn('"rationale"', risk)
        self.assertIn("higher score is riskier", risk)
        self.assertIn("0 through 100", risk)

    def test_task_body_is_raw_assignment_json_only(self):
        for name, profile in self.profiles.items():
            with self.subTest(profile=name):
                self.assertIn("body as raw JSON", profile)
                self.assertIn(
                    "no marker, Markdown fence, envelope, or prose", profile
                )
                self.assertIn(
                    "exactly `assignmentId`, `agentProfile`,\n"
                    "   `priority`, `taskType`, and `task`",
                    profile,
                )
        self.assertIn(
            "body containing only one strict WorkGraphAssignment JSON object",
            self.doc,
        )

    def test_exact_result_envelope_has_no_collapsed_or_human_wrapper(self):
        sources = {**self.profiles, "documentation": self.doc, "readme": self.readme}
        for name, content in sources.items():
            with self.subTest(source=name):
                self.assertIn(
                    "WorkGraphTaskResult/v1\n\n```json\n{\n",
                    content,
                )
                self.assertRegex(
                    content,
                    r"WorkGraphTaskResult/v1\n\n```json\n\{\n"
                    r"[\s\S]*\n\}\n```",
                )
                self.assertNotIn("<details>\n<summary>", content)
                self.assertNotIn("<summary>WorkGraph Result</summary>", content)

    def test_reporter_has_only_task_comment_mutation_routes(self):
        self.assertIn('"report_progress"', self.reporter)
        self.assertIn('"submit_task_result"', self.reporter)
        self.assertNotIn('name: "report_result"', self.reporter)
        self.assertNotRegex(self.reporter, r'request\(\s*"PATCH"')
        self.assertNotRegex(self.reporter, r'request\(\s*"PUT"')
        self.assertNotRegex(self.reporter, r'request\(\s*"DELETE"')
        self.assertNotIn("state_reason", self.reporter)
        self.assertNotIn("/labels", self.reporter)
        self.assertRegex(
            self.reporter,
            r'createComment\(taskIssueNumber, body, ambiguousWrite = false\)',
        )

    def test_reporter_requires_exact_type_and_identities(self):
        for value in [
            'const TASK_TYPE_NAME = "WorkGraphTask"',
            "WORKGRAPH_TASK_ISSUE_TYPE_ID",
            "WORKGRAPH_LAUNCHER_USER_ID",
            "WORKGRAPH_REPORTER_USER_ID",
        ]:
            self.assertIn(value, self.reporter)
        self.assertIn("exact WorkGraphTask type ID and name", self.reporter)
        self.assertIn(
            "assignment.assignmentId must equal "
            "taskType:authoritativeParentNodeId",
            self.reporter,
        )
        self.assertIn('"assignmentId"', self.reporter)
        self.assertIn('"message"', self.reporter)

    def test_progress_and_retry_guards_are_documented(self):
        for text in [
            "4096 UTF-8 bytes",
            "carriage returns",
            "legacy WorkGraph markers",
            "multiple structured",
            "foreign-authored",
            "explicit POST failure",
            "exactly one comment",
            "A second POST is never sent",
            "open or closed",
        ]:
            self.assertIn(text, self.doc)
        self.assertRegex(self.doc, r"Markdown\s+fences")
        self.assertRegex(self.doc, r"Ordinary\s+progress is ignored")

    def test_shared_prototype_identity_is_explicit(self):
        self.assertIn(
            "creator and reporter IDs may intentionally\n"
            "be the same stable bot identity",
            self.doc,
        )
        self.assertIn("separate configuration checks", self.doc)

    def test_repository_validation_profile_is_canonical(self):
        self.assertEqual(
            set(self.validation_profiles),
            {"new-issue-default"},
        )
        profile = self.validation_profiles["new-issue-default"]
        self.assertIn("## Guidance\n\n", profile)
        self.assertTrue(
            profile.endswith(
                "## Criteria\n\n"
                "1. The Issue has a non-empty title\n"
                "2. The Issue body is present\n"
            )
        )
        self.assertNotIn("\r", profile)

    def test_runtime_has_no_legacy_parent_local_contract(self):
        runtime = "\n".join([*self.profiles.values(), self.reporter])
        for obsolete in [
            "WorkGraphEvent/v1",
            "WorkGraphResult/v1",
            "WorkGraphAssignment/v1",
            "report_completion",
            "projectItemNodeId",
            "routeId",
            "responsibilityId",
            "executionId",
            "expectedEventId",
            "AwaitingRouting",
            "updateProjectV2ItemFieldValue",
        ]:
            with self.subTest(obsolete=obsolete):
                # Marker strings exist only in the reporter's reject list.
                if obsolete.startswith("WorkGraph"):
                    self.assertEqual(runtime.count(obsolete), 1)
                else:
                    self.assertNotIn(obsolete, runtime)


if __name__ == "__main__":
    unittest.main()
