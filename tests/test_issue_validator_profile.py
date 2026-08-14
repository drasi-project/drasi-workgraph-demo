import hashlib
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / ".github" / "agents" / "issue-validator.agent.md"
FIXTURE = ROOT / "tests" / "fixtures" / "issue-validator-events.json"
REPORTER = ROOT / ".github" / "mcp" / "workgraph-reporter.mjs"
REPORTER_DOC = ROOT / "docs" / "workgraph-completion-reporter.md"
MARKER = "WorkGraph-Validation: pass"


def marker_present(body):
    lines = (body or "").replace("\r\n", "\n").split("\n")
    return any(line == MARKER for line in lines)


def sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def body_digest(body):
    return f"sha256:{sha256(body or '')}"


def run_id(item_id, subject_id, digest):
    material = f"workgraph.run/v1\n{item_id}\n{subject_id}\n{digest}"
    return f"run:sha256:{sha256(material)}"


def event_id(run, event_type):
    material = f"workgraph.event/v1\n{run}\n{event_type}"
    return f"event:sha256:{sha256(material)}"


class IssueValidatorProfileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = PROFILE.read_text(encoding="utf-8")
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cls.reporter = REPORTER.read_text(encoding="utf-8")
        cls.reporter_doc = REPORTER_DOC.read_text(encoding="utf-8")

    def test_frontmatter_is_user_invocable_and_least_privileged(self):
        frontmatter = self.profile.split("---", 2)[1]
        self.assertRegex(frontmatter, r"(?m)^description: \S")
        self.assertRegex(frontmatter, r"(?m)^target: github-copilot$")
        self.assertRegex(frontmatter, r"(?m)^user-invocable: true$")
        self.assertRegex(frontmatter, r"(?m)^disable-model-invocation: true$")
        self.assertEqual(
            re.findall(r"(?m)^  - (\S+/\S+)$", frontmatter),
            ["github/issue_read", "workgraph/report_completion"],
        )
        self.assertNotIn("github/add_issue_comment", frontmatter)
        self.assertNotIn("github/projects_write", frontmatter)
        self.assertIn("mcp-servers:\n  workgraph:", frontmatter)
        self.assertIn(".github/mcp/workgraph-reporter.mjs", frontmatter)
        self.assertIn("secrets.COPILOT_MCP_WORKGRAPH_TOKEN", frontmatter)
        self.assertIn(
            "vars.COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID", frontmatter
        )
        self.assertIn(
            "vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID", frontmatter
        )

    def test_profile_requires_and_calls_with_exactly_two_fields(self):
        required = self.profile.split(
            "## Required task prompt contract", 1
        )[1].split("## Deterministic validation", 1)[0]
        required_fields = re.findall(r"(?m)^- `([^`]+)`", required)
        self.assertEqual(required_fields, ["subjectNumber", "executionId"])

        reporting = self.profile.split("## Ordered reporting", 1)[1]
        self.assertEqual(
            reporting.count(
                "call `workgraph/report_completion` exactly once with only:"
            ),
            1,
        )
        call_fields = re.findall(
            r"(?m)^- `([^`]+)`$",
            reporting.split("Do not pass", 1)[0],
        )
        self.assertEqual(call_fields, ["subjectNumber", "executionId"])
        self.assertEqual(
            {field: self.fixture["input"][field] for field in call_fields},
            self.fixture["input"],
        )

    def test_missing_issue_read_node_id_does_not_block_or_get_preserved(self):
        issue = self.fixture["issueReadWithoutSubjectNodeId"]
        self.assertNotIn("subjectNodeId", issue)
        self.assertEqual(
            issue["repository"], "drasi-project/drasi-workgraph-demo"
        )
        self.assertEqual(issue["number"], self.fixture["input"]["subjectNumber"])
        self.assertTrue(marker_present(issue["body"]))
        self.assertIn(
            "The response may omit `subjectNodeId`; its absence is not a\n"
            "   failure.",
            self.profile,
        )
        self.assertIn(
            "Do not require, derive, preserve, or pass that field", self.profile
        )

    def test_marker_match_is_complete_and_case_sensitive(self):
        self.assertTrue(marker_present(self.fixture["passed"]["body"]))
        self.assertTrue(marker_present(f"{MARKER}\r\n"))
        self.assertFalse(marker_present(self.fixture["failed"]["body"]))
        self.assertFalse(marker_present(f" {MARKER}\n"))
        self.assertFalse(marker_present(f"{MARKER} \n"))
        self.assertFalse(marker_present(f"prefix {MARKER}\n"))

    def test_shared_digest_run_and_event_vectors(self):
        identity = self.fixture["identity"]
        for name in ("passed", "failed", "emptyBody"):
            vector = self.fixture[name]
            digest = body_digest(vector["body"])
            self.assertEqual(digest, vector["contentDigest"])
            run = run_id(
                identity["projectItemNodeId"],
                identity["subjectNodeId"],
                digest,
            )
            self.assertEqual(run, vector["runId"])
            for event_type, expected in vector["eventIds"].items():
                self.assertEqual(event_id(run, event_type), expected)
        self.assertNotEqual(
            self.fixture["passed"]["contentDigest"],
            body_digest(self.fixture["passed"]["body"].replace("\n", "\r\n")),
        )

    def test_exact_common_completion_contract(self):
        self.assertIn("WorkGraphEvent/v1", self.profile)
        self.assertIn('"schemaVersion": "workgraph.event/v1"', self.profile)
        self.assertIn('"eventType": "CompletedIssueValidation"', self.profile)
        self.assertIn('"runId": "..."', self.profile)
        self.assertIn('"projectItemNodeId": "PVTI_..."', self.profile)
        self.assertIn('"subjectNodeId": "I_..."', self.profile)
        self.assertIn('"payload": {', self.profile)
        self.assertIn("Issue validation passed.", self.profile)
        self.assertIn("Issue validation failed.", self.profile)
        for forbidden in (
            '"actor"',
            '"actorType"',
            '"actorId"',
            '"repository"',
            '"subjectNumber"',
            '"subjectType"',
            '"completedAt"',
            '"routeId"',
            '"responsibilityId"',
            '"contentVersion"',
            '"profileRef"',
            '"expectedEventId"',
            '"result"',
            '"evidence"',
        ):
            self.assertNotIn(forbidden, self.profile)

    def test_reporter_is_comment_only_and_fixed_scope(self):
        self.assertIn('"drasi-project/drasi-workgraph-demo"', self.reporter)
        self.assertIn('const PROJECT_NUMBER = 3;', self.reporter)
        self.assertIn('"PVT_kwDOCX0YF84BgNE3"', self.reporter)
        self.assertNotIn("updateProjectV2ItemFieldValue", self.reporter)
        self.assertNotIn("setAwaitingRouting", self.reporter)
        self.assertNotIn("STATUS_FIELD_ID", self.reporter)
        self.assertNotIn("AWAITING_ROUTING_OPTION_ID", self.reporter)
        self.assertIn("posts one Issue comment", self.reporter_doc)
        self.assertIn("There is no fallback", self.reporter_doc)
        self.assertIn("same-user authorship", self.reporter_doc)
        self.assertIn("manual Agent Task", self.reporter_doc)


if __name__ == "__main__":
    unittest.main()
