import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / ".github" / "agents" / "issue-validator.agent.md"
FIXTURE = ROOT / "tests" / "fixtures" / "issue-validator-events.json"
MARKER = "WorkGraph-Validation: pass"


def marker_present(body):
    lines = (body or "").replace("\r\n", "\n").split("\n")
    return any(line == MARKER for line in lines)


class IssueValidatorProfileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = PROFILE.read_text(encoding="utf-8")
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_frontmatter_is_non_user_invocable_and_least_privileged(self):
        frontmatter = self.profile.split("---", 2)[1]
        self.assertRegex(frontmatter, r"(?m)^description: \S")
        self.assertRegex(frontmatter, r"(?m)^target: github-copilot$")
        self.assertRegex(frontmatter, r"(?m)^user-invocable: false$")
        self.assertRegex(frontmatter, r"(?m)^disable-model-invocation: true$")
        tools = re.findall(r"(?m)^  - (github/\S+)$", frontmatter)
        self.assertEqual(
            tools,
            [
                "github/issue_read",
                "github/add_issue_comment",
                "github/projects_write",
            ],
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
            '"completedAt": "<current UTC completion instant as '
            'YYYY-MM-DDTHH:MM:SSZ>"',
            self.profile,
        )
        self.assertNotIn('"number":', self.profile)
        event_id = self.profile.index('"eventId": "<eventId>"')
        event_type = self.profile.index(
            '"eventType": "CompletedIssueValidation"'
        )
        self.assertLess(event_id, event_type)

    def test_comment_precedes_status_update(self):
        comment = self.profile.index("Call `github/add_issue_comment` once")
        status = self.profile.index("call `github/projects_write` once")
        self.assertLess(comment, status)
        self.assertIn('"value": "AwaitingRouting"', self.profile)


if __name__ == "__main__":
    unittest.main()
