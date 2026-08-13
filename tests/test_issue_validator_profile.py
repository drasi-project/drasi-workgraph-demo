import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / ".github" / "agents" / "issue-validator.agent.md"
FIXTURE = ROOT / "tests" / "fixtures" / "issue-validator-events.json"
REPORTER_DOC = ROOT / "docs" / "workgraph-completion-reporter.md"
MARKER = "WorkGraph-Validation: pass"


def marker_present(body):
    lines = (body or "").replace("\r\n", "\n").split("\n")
    return any(line == MARKER for line in lines)


class IssueValidatorProfileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = PROFILE.read_text(encoding="utf-8")
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cls.reporter_doc = REPORTER_DOC.read_text(encoding="utf-8")

    def test_frontmatter_is_non_user_invocable_and_least_privileged(self):
        frontmatter = self.profile.split("---", 2)[1]
        self.assertRegex(frontmatter, r"(?m)^description: \S")
        self.assertRegex(frontmatter, r"(?m)^target: github-copilot$")
        self.assertRegex(frontmatter, r"(?m)^user-invocable: false$")
        self.assertRegex(frontmatter, r"(?m)^disable-model-invocation: true$")
        tools = re.findall(r"(?m)^  - (\S+/\S+)$", frontmatter)
        self.assertEqual(
            tools,
            [
                "github/issue_read",
                "workgraph/report_completion",
            ],
        )
        self.assertNotIn("github/add_issue_comment", frontmatter)
        self.assertNotIn("github/projects_write", frontmatter)
        self.assertIn("mcp-servers:\n  workgraph:", frontmatter)
        self.assertIn("command: node", frontmatter)
        self.assertIn(
            ".github/mcp/workgraph-reporter.mjs", frontmatter
        )
        self.assertIn(
            "secrets.COPILOT_MCP_WORKGRAPH_TOKEN", frontmatter
        )
        self.assertIn(
            "vars.COPILOT_MCP_WORKGRAPH_REPORTER_LOGIN", frontmatter
        )
        self.assertIn(
            "vars.COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID", frontmatter
        )
        self.assertIn(
            "vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID", frontmatter
        )

    def test_marker_match_is_complete_and_case_sensitive(self):
        self.assertTrue(marker_present(self.fixture["passed"]["body"]))
        self.assertTrue(marker_present(f"{MARKER}\r\n"))
        self.assertFalse(marker_present(self.fixture["failed"]["body"]))
        self.assertFalse(marker_present(f" {MARKER}\n"))
        self.assertFalse(marker_present(f"{MARKER} \n"))
        self.assertFalse(marker_present(f"prefix {MARKER}\n"))

    def test_result_contract_is_deterministic(self):
        self.assertEqual(
            (
                self.fixture["passed"]["result"]["outcome"],
                self.fixture["passed"]["result"]["reasonCode"],
            ),
            ("passed", "required-marker-present"),
        )
        self.assertEqual(
            (
                self.fixture["failed"]["result"]["outcome"],
                self.fixture["failed"]["result"]["reasonCode"],
            ),
            ("failed", "required-marker-missing"),
        )
        self.assertTrue(self.fixture["passed"]["result"]["evidence"]["found"])
        self.assertFalse(self.fixture["failed"]["result"]["evidence"]["found"])
        self.assertEqual(
            self.fixture["passed"]["result"]["summary"],
            "The required prototype marker is present.",
        )
        self.assertEqual(
            self.fixture["failed"]["result"]["summary"],
            "The required prototype marker is missing.",
        )
        self.assertRegex(
            self.fixture["passed"]["completedAt"],
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$",
        )
        self.assertIn("WorkGraphEvent/v1", self.profile)
        self.assertIn('"schemaVersion": "workgraph.event/v1"', self.profile)
        self.assertIn('"eventType": "CompletedIssueValidation"', self.profile)
        self.assertIn('"subjectNumber": <subjectNumber', self.profile)
        self.assertIn(
            '"completedAt": "<server-generated UTC completion instant>"',
            self.profile,
        )
        self.assertNotIn('"number":', self.profile)
        event_id = self.profile.index('"eventId": "<expectedEventId>"')
        event_type = self.profile.index(
            '"eventType": "CompletedIssueValidation"'
        )
        self.assertLess(event_id, event_type)

    def test_scoped_reporter_owns_ordered_completion(self):
        self.assertIn(
            "Call `workgraph/report_completion` exactly once", self.profile
        )
        self.assertIn(
            "organization `drasi-project`, Project number `3`", self.profile
        )
        self.assertIn("`PVT_kwDOCX0YF84BgNE3`", self.profile)
        comment = self.reporter_doc.index("Creates the canonical comment")
        status = self.reporter_doc.index("Only after the comment exists")
        self.assertLess(comment, status)
        self.assertIn("`AwaitingRouting` option ID", self.reporter_doc)
        self.assertIn(
            ".github/mcp/workgraph-reporter.mjs", self.reporter_doc
        )
        self.assertIn(
            "separate least-privilege credential", self.reporter_doc
        )
        self.assertIn("There is no fallback", self.reporter_doc)
        self.assertIn("`GITHUB_AGENT_TOKEN`", self.reporter_doc)
        self.assertIn(
            "separate launcher and reporter PATs and all four variables are configured",
            self.reporter_doc,
        )
        self.assertIn(
            "not activation\nevidence until a live `workgraph/report_completion` call",
            self.reporter_doc,
        )
        self.assertIn("same-user authorship", self.reporter_doc)
        self.assertIn("distinct immutable GitHub user IDs", self.reporter_doc)
        self.assertIn("manual Agent Task", self.reporter_doc)
        self.assertNotIn("GraphQL document", self.profile.split("---", 2)[1])


if __name__ == "__main__":
    unittest.main()
