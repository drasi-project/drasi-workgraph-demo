import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
REPORTER = ROOT / ".github" / "mcp" / "workgraph-reporter.mjs"
DOC = ROOT / "docs" / "workgraph-result-reporter.md"


class WorkGraphAgentProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profiles = {
            path.stem.removesuffix(".agent"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.reporter = REPORTER.read_text(encoding="utf-8")
        cls.doc = DOC.read_text(encoding="utf-8")

    def test_exactly_two_repository_defined_profiles_exist(self):
        self.assertEqual(
            set(self.profiles),
            {"issue-validation", "issue-risk-profile"},
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
        for name, profile in self.profiles.items():
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

    def test_validation_profile_has_typed_contract(self):
        profile = self.profiles["issue-validation"]
        self.assertIn("validationProfile", profile)
        self.assertIn("criteria", profile)
        self.assertIn('"criterion"', profile)
        self.assertIn('"passed"', profile)
        self.assertIn('"evidence"', profile)
        self.assertRegex(
            profile, r"Preserve\s+each criterion string exactly"
        )

    def test_risk_profile_has_typed_contract(self):
        profile = self.profiles["issue-risk-profile"]
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
        self.assertIn("manual\ncloud Agent Task", self.doc)
        self.assertIn("performs no deployment", self.doc)


if __name__ == "__main__":
    unittest.main()
