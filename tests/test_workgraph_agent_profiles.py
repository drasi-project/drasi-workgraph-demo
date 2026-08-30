import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
REPORTER = ROOT / ".github" / "mcp" / "workgraph-reporter.mjs"
DEFINITION = ROOT / ".github" / "mcp" / "workgraph-v1-definition.mjs"
AGENTS_CONFIG = ROOT / ".github" / "workgraph" / "agents.yaml"
DOCS = [
    ROOT / "README.md",
    ROOT / "docs" / "workgraph-result-reporter.md",
    ROOT / "docs" / "workgraph-v1-definition.md",
]

EXPECTED_TOOLS = {
    "issue-coordinator": ["workgraph/submit_task_result"],
    "issue-validator": [
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
}
EXPECTED_ENV = {
    "COPILOT_MCP_WORKGRAPH_TOKEN": "secrets",
    "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID": "vars",
    "COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID": "vars",
    "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID": "vars",
    "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID": "vars",
    "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL": "vars",
    "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN": "secrets",
}


class WorkGraphProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = {
            path.name.removesuffix(".agent.md"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.reporter = REPORTER.read_text(encoding="utf-8")
        cls.definition = DEFINITION.read_text(encoding="utf-8")
        cls.agent_config = AGENTS_CONFIG.read_text(encoding="utf-8")
        cls.docs = "\n".join(path.read_text(encoding="utf-8") for path in DOCS)

    def test_exactly_two_launchable_profiles(self):
        self.assertEqual(set(self.agents), set(EXPECTED_TOOLS))
        for name, content in self.agents.items():
            with self.subTest(name=name):
                frontmatter = content.split("---", 2)[1]
                self.assertRegex(frontmatter, rf"(?m)^name: {name}$")
                self.assertRegex(frontmatter, r"(?m)^target: github-copilot$")
                self.assertRegex(frontmatter, r"(?m)^user-invocable: true$")
                self.assertRegex(
                    frontmatter, r"(?m)^disable-model-invocation: false$"
                )
                tools_block = frontmatter.split("tools:", 1)[1].split(
                    "mcp-servers:", 1
                )[0]
                tools = re.findall(r"(?m)^  - (\S+)$", tools_block)
                self.assertEqual(tools, EXPECTED_TOOLS[name])
                server_tools = re.findall(
                    r"(?m)^      - (\S+)$",
                    frontmatter.split("\n    tools:", 1)[1].split("\n    env:", 1)[0],
                )
                self.assertEqual(
                    server_tools,
                    [tool.removeprefix("workgraph/") for tool in tools],
                )
                self.assertNotIn("github/issue_write", frontmatter)

    def test_profiles_expose_only_v1_reporter_configuration(self):
        for name, content in self.agents.items():
            with self.subTest(name=name):
                frontmatter = content.split("---", 2)[1]
                configured = dict(
                    re.findall(r"(?m)^      ([A-Z0-9_]+): (.+)$", frontmatter)
                )
                self.assertEqual(
                    set(configured),
                    set(EXPECTED_ENV) | {"COPILOT_MCP_WORKGRAPH_EXECUTOR_ID"},
                )
                for key, namespace in EXPECTED_ENV.items():
                    self.assertEqual(
                        configured[key], f"${{{{ {namespace}.{key} }}}}"
                    )
                self.assertEqual(
                    configured["COPILOT_MCP_WORKGRAPH_EXECUTOR_ID"], name
                )

    def test_agent_capacity_is_exactly_the_two_executors(self):
        entries = re.findall(
            r"  - agentId: ([A-Za-z0-9._-]+)\n"
            r"    slots: (\d+)\n"
            r"    leaseDuration: ([A-Z0-9]+)\n",
            self.agent_config,
        )
        self.assertEqual(
            entries,
            [
                ("issue-validator", "1", "PT30M"),
                ("issue-coordinator", "1", "PT15M"),
            ],
        )

    def test_only_the_v1_workgraph_contract_is_documented(self):
        production = "\n".join(
            [
                self.reporter,
                self.definition,
                self.docs,
                *self.agents.values(),
            ]
        )
        for marker in (
            "WorkGraphWorkflowDefinition/v1",
            "WorkGraphTask/v1",
            "WorkGraphTaskAssign/v1",
            "WorkGraphTaskDispatch/v1",
            "WorkGraphTaskResult/v1",
            "WorkGraphTaskEvaluate/v1",
        ):
            self.assertIn(marker, production)
        self.assertIn("Root Issue", production)
        self.assertIn("Root Task", production)
        self.assertNotRegex(production, r"WorkGraph[A-Za-z]*/v" + r"[23]")
        self.assertNotRegex(production, r"(?i)\b" + "v" + r"next\b")
        self.assertNotRegex(
            production, r"(?i)admission[- ]" + "bridge"
        )

    def test_reporter_has_only_two_narrow_tools_and_exact_lease_fields(self):
        names = re.findall(r'(?m)^\s+name: "([^"]+)",$', self.reporter)
        self.assertEqual(names, ["get_root_issue", "submit_task_result"])
        self.assertIn(
            'const LEASE_VALIDATION_PATH = "/github/workgraph-v1/lease/validate"',
            self.reporter,
        )
        for field in (
            "taskId",
            "leaseId",
            "assignmentId",
            "executorId",
            "slotId",
        ):
            self.assertIn(field, self.reporter)


if __name__ == "__main__":
    unittest.main()
