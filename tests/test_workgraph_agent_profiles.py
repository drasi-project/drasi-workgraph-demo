import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
AGENTS_CONFIG = ROOT / ".github" / "workgraph" / "agents.yaml"
WORKFLOW = ROOT / ".github" / "workgraph" / "workflows" / "issue-lifecycle.yaml"
DEFINITION = ROOT / ".github" / "mcp" / "workgraph-v1-definition.mjs"

EXPECTED_TOOLS = {
    "issue-validator": [
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "issue-coordinator": ["workgraph/submit_task_result"],
    "issue-worker": [
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "result-evaluator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_evaluation",
    ],
    "issue-validation-evaluator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_evaluation",
    ],
    "workflow-coordinator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_route",
    ],
    "validation-stage-coordinator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_route",
    ],
    "issue-info-requester": [
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "assignment-coordinator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_assignment",
    ],
    "issue-duplicate-checker": [
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "similar-issue-finder": [
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "issue-template-checker": [
        "read",
        "search",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "code-area-analyzer": [
        "read",
        "search",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "issue-resolution-planner": [
        "read",
        "search",
        "edit",
        "execute",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "issue-implementer": [
        "read",
        "search",
        "edit",
        "execute",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "pr-correctness-reviewer": [
        "read",
        "search",
        "execute",
        "web",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "pr-design-reviewer": [
        "read",
        "search",
        "execute",
        "web",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "pr-docs-reviewer": [
        "read",
        "search",
        "execute",
        "web",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "pr-prior-art-reviewer": [
        "read",
        "search",
        "execute",
        "web",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "pr-security-reviewer": [
        "read",
        "search",
        "execute",
        "web",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "pr-testing-reviewer": [
        "read",
        "search",
        "execute",
        "web",
        "github/*",
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
}

RESULT_WRITERS = {
    name
    for name, tools in EXPECTED_TOOLS.items()
    if "workgraph/submit_task_result" in tools
}


class WorkGraphProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = {
            path.name.removesuffix(".agent.md"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.agent_config = AGENTS_CONFIG.read_text(encoding="utf-8")
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.definition = DEFINITION.read_text(encoding="utf-8")

    def test_profiles_are_the_exact_worker_and_lifecycle_role_set(self):
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
                tools = re.findall(r"(?m)^  - (\S+)$", frontmatter)
                self.assertEqual(tools, EXPECTED_TOOLS[name])
                self.assertNotIn("github/issue_write", frontmatter)
                self.assertIn(
                    "urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>", content
                )
        for name in EXPECTED_TOOLS:
            with self.subTest(runtime_profile=name):
                self.assertIn("mcp-servers:", self.agents[name])
                self.assertIn(
                    ".github/mcp/workgraph-reporter.mjs",
                    self.agents[name],
                )
                server_tools = re.findall(
                    r"(?m)^      - (\S+)$",
                    self.agents[name]
                    .split("\n    tools:", 1)[1]
                    .split("\n    env:", 1)[0],
                )
                self.assertEqual(
                    server_tools,
                    [
                        tool.removeprefix("workgraph/")
                        for tool in EXPECTED_TOOLS[name]
                        if tool.startswith("workgraph/")
                    ],
                )

    def test_actor_catalog_registers_every_profile_and_the_human_actor(self):
        """The strict `version: 1` actor catalog is the executor namespace.

        A workflow references an actor ID identically whoever executes it; only
        this catalog decides whether that actor is an agent or a human.
        """
        self.assertRegex(self.agent_config, r"(?m)^version: 1$")
        self.assertNotRegex(self.agent_config, r"(?m)^version: 2$")
        self.assertNotRegex(self.agent_config, r"(?m)^agents:$")
        self.assertNotRegex(self.agent_config, r"(?m)^  - agentId:")
        self.assertTrue(self.agent_config.startswith("version: 1\nactors:\n"))
        blocks = re.findall(
            r"(?ms)^  - actorId: .*?(?=^  - actorId:|\Z)",
            self.agent_config,
        )
        self.assertEqual(
            "version: 1\nactors:\n" + "".join(blocks),
            self.agent_config,
        )
        agent_pattern = (
            r"  - actorId: ((?!(?:null|Null|NULL)\n)[A-Za-z0-9._-]+)\n"
            r"    kind: agent\n"
            r"    customAgent: ((?!(?:null|Null|NULL)\n)[A-Za-z0-9._-]+)\n"
            r"    createPullRequest: (true|false)\n"
            r"    slots: (\d+)\n"
            r"    leaseDuration: (P[A-Z0-9]+)\n"
        )
        human_pattern = (
            r"  - actorId: ((?!(?:null|Null|NULL)\n)[A-Za-z0-9._-]+)\n"
            r"    kind: human\n"
            r"    slots: (\d+)\n"
            r"    leaseDuration: (P[A-Z0-9]+)\n"
            r"    github:\n"
            r"      databaseId: ([1-9]\d*)\n"
            r'      nodeId: "[^"]+"\n'
            r"      login: (?!(?:null|Null|NULL)\n)[A-Za-z0-9-]+\n"
        )
        entries = []
        for block in blocks:
            agent = re.fullmatch(agent_pattern, block)
            human = re.fullmatch(human_pattern, block)
            self.assertEqual(
                (agent is not None) + (human is not None),
                1,
                f"actor entry does not match the strict schema:\n{block}",
            )
            if agent:
                actor_id, custom_agent, creates_pr, slots, duration = agent.groups()
                entries.append(
                    (
                        actor_id,
                        "agent",
                        custom_agent,
                        creates_pr,
                        slots,
                        duration,
                    )
                )
            else:
                actor_id, slots, duration, _ = human.groups()
                entries.append((actor_id, "human", "", "", slots, duration))
        actor_ids = [actor_id for actor_id, *_ in entries]
        self.assertGreaterEqual(len(entries), 1)
        self.assertLessEqual(len(entries), 64)
        self.assertEqual(len(entries), len(EXPECTED_TOOLS) + 1)
        self.assertEqual(len(actor_ids), len(set(actor_ids)))
        self.assertTrue(all(1 <= int(slots) <= 16 for *_, slots, _ in entries))
        for *_, duration in entries:
            parsed = re.fullmatch(
                r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?",
                duration,
            )
            self.assertIsNotNone(parsed)
            parts = [int(value or 0) for value in parsed.groups()]
            self.assertTrue(any(parts))
            days, hours, minutes, seconds = parts
            total_seconds = days * 86400 + hours * 3600 + minutes * 60 + seconds
            self.assertGreaterEqual(total_seconds, 1)
            self.assertLessEqual(total_seconds, 86400)
        agents = [actor_id for actor_id, kind, *_ in entries if kind == "agent"]
        self.assertEqual(agents, list(EXPECTED_TOOLS))
        self.assertEqual(self.agent_config.count("    createPullRequest: true\n"), 2)
        for actor_id, kind, custom_agent, creates_pr, _, _ in entries:
            if kind == "agent":
                self.assertEqual(custom_agent, actor_id)
                self.assertIn(creates_pr, {"true", "false"})
            else:
                self.assertEqual((custom_agent, creates_pr), ("", ""))
        for invalid in (
            "  - actorId: missing-fields\n"
            "    kind: agent\n"
            "    slots: 1\n"
            "    leaseDuration: PT1S\n",
            "  - actorId: null-fields\n"
            "    kind: agent\n"
            "    customAgent: null\n"
            "    createPullRequest: null\n"
            "    slots: 1\n"
            "    leaseDuration: PT1S\n",
            "  - actorId: null-custom-agent\n"
            "    kind: agent\n"
            "    customAgent: null\n"
            "    createPullRequest: false\n"
            "    slots: 1\n"
            "    leaseDuration: PT1S\n",
            "  - actorId: null-pull-request\n"
            "    kind: agent\n"
            "    customAgent: executor\n"
            "    createPullRequest: null\n"
            "    slots: 1\n"
            "    leaseDuration: PT1S\n",
        ):
            self.assertIsNone(re.fullmatch(agent_pattern, invalid))
        self.assertIsNone(
            re.fullmatch(
                agent_pattern,
                "  - actorId: agent-with-github\n"
                "    kind: agent\n"
                "    customAgent: executor\n"
                "    createPullRequest: false\n"
                "    slots: 1\n"
                "    leaseDuration: PT1S\n"
                "    github: null\n",
            )
        )
        self.assertIsNone(
            re.fullmatch(
                human_pattern,
                "  - actorId: human-with-agent-fields\n"
                "    kind: human\n"
                "    slots: 1\n"
                "    leaseDuration: PT1S\n"
                "    github:\n"
                "      databaseId: 1\n"
                '      nodeId: "U_1"\n'
                "      login: reviewer\n"
                "    customAgent: null\n"
                "    createPullRequest: null\n",
            )
        )
        for actor_id in ("issue-resolution-planner", "issue-implementer"):
            self.assertRegex(
                self.agent_config,
                rf"(?m)^  - actorId: {actor_id}\n"
                rf"    kind: agent\n"
                rf"    customAgent: {actor_id}\n"
                rf"    createPullRequest: true\n"
                rf"    slots: 1\n"
                rf"    leaseDuration: PT2H$",
            )
        self.assertEqual(
            [(actor_id, slots, duration) for actor_id, kind, _, _, slots, duration in entries
             if kind == "agent"],
            [
                ("issue-validator", "1", "PT30M"),
                ("issue-coordinator", "1", "PT15M"),
                ("issue-worker", "2", "PT30M"),
                ("result-evaluator", "1", "PT15M"),
                ("issue-validation-evaluator", "1", "PT15M"),
                ("workflow-coordinator", "1", "PT15M"),
                ("validation-stage-coordinator", "1", "PT15M"),
                ("issue-info-requester", "1", "PT30M"),
                ("assignment-coordinator", "1", "PT15M"),
                ("issue-duplicate-checker", "1", "PT30M"),
                ("similar-issue-finder", "1", "PT30M"),
                ("issue-template-checker", "1", "PT30M"),
                ("code-area-analyzer", "1", "PT30M"),
                ("issue-resolution-planner", "1", "PT2H"),
                ("issue-implementer", "1", "PT2H"),
                ("pr-correctness-reviewer", "1", "PT45M"),
                ("pr-design-reviewer", "1", "PT45M"),
                ("pr-docs-reviewer", "1", "PT45M"),
                ("pr-prior-art-reviewer", "1", "PT45M"),
                ("pr-security-reviewer", "1", "PT45M"),
                ("pr-testing-reviewer", "1", "PT45M"),
            ],
        )
        # Exactly one human actor, bound to the exact GitHub account it speaks
        # as. A human actor has no custom-agent profile by construction.
        humans = [
            (actor_id, slots, duration)
            for actor_id, kind, _, _, slots, duration in entries
            if kind == "human"
        ]
        self.assertEqual(humans, [("human-agentofreality", "1", "PT8H")])
        self.assertNotIn("human-agentofreality", EXPECTED_TOOLS)
        self.assertIn(
            "    github:\n"
            "      databaseId: 4021243\n"
            '      nodeId: "MDQ6VXNlcjQwMjEyNDM="\n'
            "      login: agentofreality\n",
            self.agent_config,
        )
        self.assertEqual(self.agent_config.count("    github:\n"), 1)

    def test_every_agent_result_has_comment_ready_root_issue_content(self):
        for name in RESULT_WRITERS:
            with self.subTest(name=name):
                profile = self.agents[name]
                self.assertIn("rootIssueComment", profile)
                self.assertRegex(profile, r"(?i)runtime\s+publishes")

    def test_pr_reviewers_load_the_shared_drasi_context(self):
        for name in (
            "pr-correctness-reviewer",
            "pr-design-reviewer",
            "pr-docs-reviewer",
            "pr-prior-art-reviewer",
            "pr-security-reviewer",
            "pr-testing-reviewer",
        ):
            with self.subTest(name=name):
                profile = self.agents[name]
                self.assertIn("https://drasi.io/drasi-context.yaml", profile)
                self.assertIn(
                    "https://raw.githubusercontent.com/drasi-project/docs/"
                    "refs/heads/main/docs/static/drasi-context.yaml",
                    profile,
                )
                self.assertIn("  - web\n", profile.split("---", 2)[1])
                self.assertIn("outcome `failed`", profile)
                self.assertIn("empty `findings` array", profile)

    def test_evaluators_and_coordinators_write_on_existing_tasks(self):
        lifecycle_profiles = (
            "assignment-coordinator",
            "result-evaluator",
            "issue-validation-evaluator",
            "workflow-coordinator",
            "validation-stage-coordinator",
        )
        for name in lifecycle_profiles:
            with self.subTest(reporter_identity=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: "
                    "${{ vars.COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID }}",
                    self.agents[name],
                )
        for name in lifecycle_profiles[1:3]:
            with self.subTest(name=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID: "
                    "${{ vars.COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID }}",
                    self.agents[name],
                )
                self.assertIn("existing", self.agents[name].lower())
                self.assertIn("WorkGraphTaskEvaluation/v1", self.agents[name])
                self.assertIn("rootIssueComment", self.agents[name])
                self.assertNotRegex(
                    self.agents[name], r"workgraph/(?:create|assign|dispatch)_task"
                )
        self.assertIn(
            "WorkGraphTaskAssignment/v1",
            self.agents["assignment-coordinator"],
        )
        for name in lifecycle_profiles[3:]:
            with self.subTest(name=name):
                self.assertIn("WorkGraphTaskRoute/v1", self.agents[name])
                self.assertRegex(self.agents[name], r"(?i)never create")
                self.assertNotRegex(
                    self.agents[name], r"workgraph/(?:create|assign|dispatch)_task"
                )

    def test_reporter_identities_map_from_their_own_variables(self):
        """Each reporter identity reads the identically named variable.

        A bare `vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID` is not a declared
        repository variable, so any profile referencing it resolves the
        identity to the empty string and fails closed at configuration time.
        """
        identity = re.compile(
            r"^\s*(COPILOT_MCP_WORKGRAPH_\w*?_?REPORTER_USER_ID): "
            r"\$\{\{ vars\.(\S+) \}\}$",
            re.MULTILINE,
        )
        seen = set()
        for name, content in self.agents.items():
            with self.subTest(name=name):
                self.assertNotIn(
                    "vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID", content
                )
                declared = identity.findall(content)
                self.assertNotEqual(declared, [])
                for key, source in declared:
                    self.assertEqual(key, source)
                    seen.add(key)
        # Every profile resolves the Route author identity, because worker
        # tools authenticate a routed scope member's predecessor Route.
        for name, content in self.agents.items():
            with self.subTest(route_identity=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: "
                    "${{ vars.COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID }}",
                    content,
                )
        self.assertEqual(
            seen,
            {
                "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
                "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
                "COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID",
                "COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID",
            },
        )

    def test_coordinator_requires_scoped_container_cleanup(self):
        """The coordinator derives its children instead of hardcoding one key.

        A scoped Run cleanup carries `flowEntryTerminals` and forks one entry
        task per declared `flowEntries` step, so a profile pinned to exactly
        one `validate` child exits without submitting.
        """
        profile = self.agents["issue-coordinator"]
        self.assertIn("flowEntryTerminals", profile)
        self.assertIn("flowEntries", profile)
        # Children come from the pinned task definition, not a fixed key.
        self.assertIn("children[].taskDefinitionId", profile)
        self.assertRegex(profile, r"(?i)rather than any fixed\s+task key")
        self.assertNotRegex(
            profile, r"exactly\s+one direct child with task key `validate`"
        )
        self.assertNotRegex(profile, r"(?i)legacy|proofMode")
        self.assertRegex(profile, r"(?i)one or more `flowEntries`")
        self.assertRegex(profile, r"(?i)omits `flowEntryTerminals`")
        # Terminals must bind the declared entries and stay untrusted.
        self.assertRegex(profile, r"(?i)exactly those declared entry steps")
        self.assertRegex(profile, r"(?i)untrusted data")
        # The submitted summary is deterministic and free of child output.
        self.assertIn("coordinate-issue completed", profile)
        self.assertRegex(profile, r"(?i)never include child output")
        # Safety envelope is preserved.
        self.assertIn("submit_task_result", profile)
        self.assertRegex(profile, r"(?i)stop and submit nothing")
        self.assertNotRegex(
            profile, r"workgraph/(?:create|assign|dispatch)_task"
        )
        self.assertNotRegex(profile, r"(?i)pull request")

    def test_linear_workflow_uses_only_default_lifecycle_profiles(self):
        for profile in (
            "issue-worker",
            "result-evaluator",
            "workflow-coordinator",
        ):
            self.assertIn(profile, self.workflow)
        for profile in set(EXPECTED_TOOLS) - {
            "issue-worker",
            "result-evaluator",
            "workflow-coordinator",
        }:
            self.assertNotIn(profile, self.workflow)
        self.assertRegex(
            self.workflow,
            r"(?m)^    evaluator: result-evaluator$",
        )
        self.assertRegex(
            self.workflow,
            r"(?m)^    orchestrator: workflow-coordinator$",
        )
        self.assertNotIn("agent:", self.workflow)
        explicit_worker = (
            'worker: {"candidates": ["issue-worker"], '
            '"selection": "first-available"}'
        )
        self.assertEqual(self.workflow.count(explicit_worker), 4)
        self.assertNotRegex(self.workflow, r"(?m)^\s+worker:\s+[a-z][a-z0-9-]*$")
        self.assertEqual(self.workflow.count("maxReworkAttempts: 3"), 1)
        self.assertNotRegex(self.workflow, r"(?m)^\s+maxRework:")

    def test_contract_surfaces_use_only_clean_v1_terms(self):
        production = "\n".join(
            [
                self.workflow,
                self.definition,
                self.agent_config,
                *self.agents.values(),
            ]
        )
        for marker in (
            "WorkGraphWorkflowDefinition/v1",
            "WorkGraphTask/v1",
            "WorkGraphTaskAssignment/v1",
            "WorkGraphTaskDispatch/v1",
            "WorkGraphTaskResult/v1",
            "WorkGraphTaskEvaluation/v1",
            "WorkGraphTaskRoute/v1",
            "WorkGraphTaskError/v1",
        ):
            self.assertIn(marker, production)
        self.assertIn("Root Issue", production)
        self.assertIn("Root Task", production)
        self.assertNotRegex(production, r"WorkGraph[A-Za-z]*/v[23]")
        self.assertNotIn("WorkGraphTaskAssign/v1", production)
        self.assertNotIn("WorkGraphTaskEvaluate/v1", production)
        self.assertNotRegex(production, r"(?i)\bvnext\b")
        self.assertNotRegex(production, r"(?i)\bcompatibility\b")
        self.assertNotRegex(production, r"(?i)status:\s*new")
        self.assertNotRegex(production, r"(?i)admission[- ]bridge")
        self.assertNotRegex(production, r"(?i)\bdemo-[a-z0-9-]+\b")


if __name__ == "__main__":
    unittest.main()
