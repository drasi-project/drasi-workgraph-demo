import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
REPORTER = ROOT / ".github" / "mcp" / "workgraph-reporter.mjs"
PROFILE = (
    ROOT
    / ".github"
    / "workgraph"
    / "profiles"
    / "issue-validation"
    / "new-issue-default.md"
)
DOC = ROOT / "docs" / "workgraph-result-reporter.md"
README = ROOT / "README.md"

EXPECTED_TOOLS = {
    "issue-orchestrator": ["github/issue_read", "workgraph/transition_issue"],
    "issue-assigner": [
        "github/issue_read",
        "workgraph/submit_task_assignment",
    ],
    "issue-validator": [
        "github/issue_read",
        "workgraph/submit_task_result",
    ],
    "issue-info-requester": [
        "github/issue_read",
        "workgraph/post_parent_info_request",
        "workgraph/submit_task_result",
    ],
    "workgraph-result-acceptor": [
        "github/issue_read",
        "workgraph/get_result_snapshot",
        "workgraph/submit_result_acceptance",
        "workgraph/feedback_and_redispatch",
    ],
}

IDENTITY_KEYS = [
    "COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
    "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_REDISPATCH_REPORTER_USER_ID",
]


class WorkGraphProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = {
            path.name.removesuffix(".agent.md"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.reporter = REPORTER.read_text(encoding="utf-8")
        cls.profile = PROFILE.read_text(encoding="utf-8")
        cls.doc = DOC.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")

    def test_exactly_five_rest_launchable_profiles(self):
        self.assertEqual(set(self.agents), set(EXPECTED_TOOLS))
        self.assertNotIn("risk-profiler", "\n".join(self.agents.values()))
        for name, content in self.agents.items():
            with self.subTest(name=name):
                frontmatter = content.split("---", 2)[1]
                self.assertRegex(frontmatter, rf"(?m)^name: {name}$")
                self.assertRegex(frontmatter, r"(?m)^user-invocable: true$")
                self.assertRegex(
                    frontmatter, r"(?m)^disable-model-invocation: false$"
                )
                self.assertIn("target: github-copilot", frontmatter)
                tools_block = frontmatter.split("tools:", 1)[1].split(
                    "mcp-servers:", 1
                )[0]
                tools = re.findall(r"(?m)^  - (\S+)$", tools_block)
                self.assertEqual(tools, EXPECTED_TOOLS[name])
                self.assertNotIn("github/issue_write", frontmatter)
                self.assertNotIn("github/add_issue_comment", frontmatter)

    def test_profiles_pin_type_and_separate_identities(self):
        for name, content in self.agents.items():
            with self.subTest(name=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: "
                    "IT_kwDOCX0YF84CKGIJ",
                    content,
                )
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_TOKEN: "
                    "${{ secrets.COPILOT_MCP_WORKGRAPH_TOKEN }}",
                    content,
                )
                for key in IDENTITY_KEYS:
                    self.assertIn(key, content)

    def test_task_contract_is_exact_and_closed(self):
        for text in [self.doc, self.reporter]:
            self.assertIn("WorkGraphTask/v1", text)
            self.assertIn("validate-issue", text)
            self.assertIn("request-info", text)
            self.assertIn("new-issue-default", text)
            self.assertIn("validationResultCommentNodeId", text)
        self.assertIn("minimal canonical YAML grammar", self.doc)
        self.assertIn("There is no generic task registry", self.doc)
        self.assertIn('const TASK_TYPE_NAME = "WorkGraphTask"', self.reporter)
        self.assertNotIn("issue-risk-profile", self.reporter)

    def test_exact_comment_contracts_and_result_fields(self):
        for marker in [
            "WorkGraphTaskAssignment/v1",
            "WorkGraphTaskResult/v1",
            "WorkGraphTaskResultAcceptance/v1",
        ]:
            self.assertIn(marker, self.doc)
            self.assertIn(marker, self.reporter)
        self.assertIn('"agentProfile": "issue-validator"', self.doc)
        self.assertIn("There is no `assignmentId`", self.doc)
        self.assertNotIn('"assignmentId"', self.reporter)
        for field in [
            "requestCommentNodeId",
            "resultCommentNodeId",
            "resultBodyDigest",
        ]:
            self.assertIn(field, self.doc)
            self.assertIn(field, self.reporter)
        self.assertIn("sha256:<64 lowercase hex>", self.reporter)

    def test_reporter_exposes_only_narrow_tools(self):
        names = re.findall(
            r'(?m)^    name: "(get_result_snapshot|submit_task_assignment|submit_task_result|'
            r'submit_result_acceptance|transition_issue|'
            r'post_parent_info_request|feedback_and_redispatch)"',
            self.reporter,
        )
        self.assertEqual(set(names), {
            "get_result_snapshot",
            "submit_task_assignment",
            "submit_task_result",
            "submit_result_acceptance",
            "transition_issue",
            "post_parent_info_request",
            "feedback_and_redispatch",
        })
        self.assertNotIn("report_progress", self.reporter)
        self.assertNotIn("issue-risk", self.reporter)
        self.assertIn('patchComment(id, body)', self.reporter)
        self.assertIn("ensureTransitionTask", self.reporter)
        self.assertIn("findUnattachedTransitionTask", self.reporter)
        self.assertNotIn("state_reason", self.reporter)

    def test_orchestrator_state_machine_and_reconciliation_are_explicit(self):
        orchestrator = self.agents["issue-orchestrator"]
        for value in [
            "status:new",
            "status:awaiting-validation",
            "status:awaiting-need-info",
            "status:awaiting-triage",
            "start-validation",
            "advance-validation",
            "resume-after-human-reply",
            "stale supplied status",
            "unexpected open sibling",
            "no-op",
        ]:
            self.assertIn(value, orchestrator)
        self.assertIn(
            "reconcile expected state\nimmediately before writing", self.doc
        )
        self.assertIn("does not provide a\ntransaction", self.doc)
        self.assertIn("greatest Issue number", self.doc)
        self.assertIn("canonical title/body correlation", self.doc)
        self.assertIn("without creating another task", self.doc)
        self.assertIn("never type or untype an Issue", orchestrator)
        self.assertIn("initial create request", orchestrator)
        self.assertIn("No tool exposes an Issue Type", self.doc)

    def test_worker_and_acceptor_provenance_rules(self):
        validator = self.agents["issue-validator"]
        self.assertIn("native parent; that relation is\nauthoritative", validator)
        self.assertIn('outcome:\n"succeeded"', validator)
        self.assertIn("PATCHes the existing canonical Result", validator)

        requester = self.agents["issue-info-requester"]
        self.assertIn("mentions the parent's submitter", requester)
        self.assertIn("requestCommentNodeId", requester)

        acceptor = self.agents["workgraph-result-acceptor"]
        self.assertIn("exact current Result", acceptor)
        self.assertIn("SHA-256", acceptor)
        self.assertIn("submit no Acceptance", acceptor)
        self.assertIn("external WorkGraph dispatcher", acceptor)
        self.assertIn("PATCHes the one feedback comment", acceptor)

    def test_fail_closed_race_and_feedback_revision_are_documented(self):
        self.assertIn("Unavoidable REST race and remediation", self.doc)
        self.assertIn("performs no compensating delete", self.doc)
        self.assertIn("Manual remediation is required", self.doc)
        self.assertIn("Feedback is bound to the exact current Result digest", self.doc)
        self.assertIn("resultBodyDigest", self.reporter)
        self.assertIn("Result/Acceptance race left the task inconsistent", self.reporter)
        self.assertNotIn("deleteComment", self.reporter)

    def test_result_and_acceptance_never_close_task(self):
        sources = "\n".join(
            [self.reporter, self.doc, self.readme, *self.agents.values()]
        )
        self.assertIn("A Result never closes a task", self.readme)
        self.assertIn("It never changes Issue state and never closes the task", self.doc)
        self.assertNotRegex(self.reporter, r'["`]state["`]\s*:')
        self.assertNotIn("closeIssue", self.reporter)
        self.assertIn("external WorkGraph runtime may close", sources)

    def test_core_graph_contract_names_are_exact(self):
        for value in (
            "`WorkGraphTask`: `taskType`, `inputs`",
            "`WorkGraphTaskAssignment`: `agentProfile`",
            "`WorkGraphTaskResult`: computed `bodyDigest`",
            "`WorkGraphTaskResultAcceptance`: `resultCommentNodeId`",
            "`ASSIGNMENT_FOR`",
            "`RESULT_FOR`",
            "`ACCEPTS_RESULT`",
            "`COMMENT_ON`",
            "`resultBodyDigest` equals that Result node's `bodyDigest`",
        ):
            self.assertIn(value, self.doc)

    def test_repository_validation_profile_is_unchanged_two_criteria(self):
        self.assertTrue(
            self.profile.endswith(
                "## Criteria\n\n"
                "1. The Issue has a non-empty title\n"
                "2. The Issue body is present\n"
            )
        )
        self.assertEqual(self.profile.count("\n1. "), 1)
        self.assertEqual(self.profile.count("\n2. "), 1)
        self.assertNotIn("\r", self.profile)


if __name__ == "__main__":
    unittest.main()
