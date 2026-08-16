import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
REPORTER = ROOT / ".github" / "mcp" / "workgraph-reporter.mjs"
DOC = ROOT / "docs" / "workgraph-result-reporter.md"
README = ROOT / "README.md"
PROFILE_TASK_TYPES = {
    "issue-validator": "issue-validation",
    "issue-risk-profiler": "issue-risk-profile",
}


class WorkGraphAgentProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profiles = {
            path.stem.removesuffix(".agent"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.reporter = REPORTER.read_text(encoding="utf-8")
        cls.doc = DOC.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")

    def test_exactly_two_repository_defined_profile_files_exist(self):
        self.assertEqual(
            set(self.profiles),
            set(PROFILE_TASK_TYPES),
        )
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
                tools = re.findall(
                    r"(?m)^  - (\S+/\S+)$", frontmatter
                )
                self.assertEqual(
                    tools,
                    ["github/issue_read", "workgraph/report_result"],
                )
                self.assertIn(
                    ".github/mcp/workgraph-reporter.mjs", frontmatter
                )
                self.assertIn(
                    "secrets.COPILOT_MCP_WORKGRAPH_TOKEN", frontmatter
                )
                self.assertIn(
                    "vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID",
                    frontmatter,
                )
                self.assertNotIn("github/add_issue_comment", frontmatter)
                self.assertNotIn("github/projects_write", frontmatter)

    def test_profiles_lock_assignment_and_result_envelopes(self):
        for name in PROFILE_TASK_TYPES:
            profile = self.profiles[name]
            with self.subTest(profile=name):
                self.assertIn("WorkGraphAssignment/v1", profile)
                self.assertIn("WorkGraphResult/v1", profile)
                self.assertIn("exactly one", profile)
                self.assertIn("assignmentId", profile)
                self.assertIn("agentProfile", profile)
                self.assertIn("priority", profile)
                self.assertIn("outcome", profile)
                self.assertIn("succeeded", profile)
                self.assertIn("failed", profile)
                self.assertIn("blocked", profile)
                self.assertRegex(
                    profile,
                    r"Call\s+`workgraph/report_result` exactly once",
                )
                self.assertIn("current Issue fields", profile)

    def test_profiles_preserve_assignment_task_types(self):
        for name, task_type in PROFILE_TASK_TYPES.items():
            profile = self.profiles[name]
            with self.subTest(profile=name):
                self.assertEqual(
                    set(re.findall(r'"taskType": "([^"]+)"', profile)),
                    {task_type},
                )

    def test_profiles_require_concise_nonredundant_summaries(self):
        for name, profile in self.profiles.items():
            with self.subTest(profile=name):
                self.assertIn("concise plain-text summary", profile)
                self.assertIn(
                    "without\nmentioning the current Issue number or ID",
                    profile,
                )

    def test_documented_result_envelopes_are_closed_and_collapsed(self):
        for name, content in {
            **self.profiles,
            "documentation": self.doc,
            "readme": self.readme,
        }.items():
            with self.subTest(source=name):
                self.assertIn("<details>", content)
                self.assertNotIn("<details open", content)
                self.assertIn(
                    "<summary>WorkGraph Result</summary>\n\n"
                    "WorkGraphResult/v1\n\n",
                    content,
                )
                self.assertRegex(
                    content,
                    r"```json\n\{\n[\s\S]*\n\}\n```\n</details>",
                )

    def test_examples_do_not_repeat_an_issue_number(self):
        examples = "\n".join(
            [*self.profiles.values(), self.doc, self.readme]
        )
        self.assertNotRegex(examples, r"(?i)\bissue\s*#?\d+\b")

    def test_validation_profile_has_typed_contract(self):
        profile = self.profiles["issue-validator"]
        self.assertIn("validationProfile", profile)
        self.assertIn("criteria", profile)
        self.assertIn('"criterion"', profile)
        self.assertIn('"passed"', profile)
        self.assertIn('"evidence"', profile)
        self.assertRegex(
            profile, r"Preserve\s+each criterion string exactly"
        )

    def test_risk_profile_has_typed_contract(self):
        profile = self.profiles["issue-risk-profiler"]
        self.assertIn("riskProfile", profile)
        self.assertIn("dimensions", profile)
        self.assertIn('"dimension"', profile)
        self.assertIn('"score"', profile)
        self.assertIn('"rationale"', profile)
        self.assertIn("higher score is riskier", profile)
        self.assertIn("0 through 100", profile)

    def test_runtime_surface_does_not_revive_legacy_protocol(self):
        runtime = "\n".join([*self.profiles.values(), self.reporter])
        for obsolete in [
            "WorkGraphEvent/v1",
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
                self.assertNotIn(obsolete, runtime)

    def test_documentation_records_retry_and_activation_limits(self):
        self.assertIn("assignmentId", self.doc)
        self.assertIn("different author", self.doc)
        self.assertIn("ambiguous", self.doc)
        self.assertIn("never sends a second create request", self.doc)
        self.assertIn("concurrent first attempts can race", self.doc)
        self.assertIn("Literal `\\n` text is not a line break", self.doc)
        self.assertIn("compact or otherwise non-pretty JSON", self.doc)
        self.assertIn("manual\ncloud Agent Task", self.doc)
        self.assertIn("performs no deployment", self.doc)


if __name__ == "__main__":
    unittest.main()
