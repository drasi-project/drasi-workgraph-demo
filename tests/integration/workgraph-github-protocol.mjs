import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAcceptance,
  formatAssignment,
  formatFeedback,
  formatTaskResult,
  parseTask,
  resultDigest,
} from "../../.github/mcp/workgraph-reporter.mjs";
import {
  GitHubClient,
  TASK_BODY,
  TASK_PAYLOAD,
  childTitle,
  cleanupRun,
  invokeReporter,
  loadLiveConfig,
  makeRunMarker,
  parentBody,
  parentTitle,
  startLeaseValidator,
} from "../support/workgraph-live-github.mjs";

const MARKERS = {
  assignment: "WorkGraphTaskAssignment/v1",
  result: "WorkGraphTaskResult/v1",
  feedback: "WorkGraphTaskFeedback/v1",
  acceptance: "WorkGraphTaskResultAcceptance/v1",
};
const CRITERIA = [
  "The Issue has a non-empty title",
  "The Issue body is present",
];

function references(parent, child) {
  return {
    taskIssueNumber: child.number,
    taskIssueNodeId: child.id,
    parentIssueNumber: parent.number,
    parentIssueNodeId: parent.id,
  };
}

function commentsSnapshot(comments) {
  return comments.map(({ id, node_id, body, user }) => ({
    id,
    node_id,
    body,
    authorId: user?.id,
  }));
}

function markerComments(comments, marker) {
  return comments.filter((comment) => comment.body.includes(marker));
}

function oneMarkerComment(comments, marker) {
  const found = markerComments(comments, marker);
  assert.equal(found.length, 1, `expected exactly one ${marker} comment`);
  return found[0];
}

function assertToolSuccess(response) {
  assert.equal(response.isError, false, response.content?.[0]?.text);
  return response.structuredContent;
}

function assertToolError(response, expected) {
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, expected);
}

function iso(milliseconds) {
  return new Date(Math.floor(milliseconds / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
}

function leaseFor({
  marker,
  attempt,
  child,
  assignmentCommentNodeId,
  acquiredAt = Date.now() - 60_000,
}) {
  return {
    leaseId: `${marker.replaceAll("/", "-")}-lease-${attempt}`,
    taskNodeId: child.id,
    assignmentCommentNodeId,
    agentId: "issue-validator",
    slotId: "issue-validator/1",
    taskType: "validate-issue",
    acquiredAt: iso(acquiredAt),
    expiresAt: iso(acquiredAt + 15 * 60_000),
  };
}

function leaseArguments(lease) {
  return {
    assignmentCommentNodeId: lease.assignmentCommentNodeId,
    leaseId: lease.leaseId,
    agentId: lease.agentId,
    slotId: lease.slotId,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}

const liveEnabled = process.env.WORKGRAPH_GITHUB_INTEGRATION === "1";

test(
  "direct GitHub WorkGraph protocol is canonical, idempotent, and fail closed",
  {
    skip: liveEnabled
      ? false
      : "requires explicit WORKGRAPH_GITHUB_INTEGRATION=1",
    timeout: 180_000,
  },
  async (t) => {
    const config = loadLiveConfig();
    const client = new GitHubClient(config.token);
    const viewer = await client.repositoryAndViewer();
    const roleIds = new Set(Object.values(config.roleIds));
    assert.deepEqual(
      [...roleIds],
      [viewer.id],
      "the single-token live harness requires every configured writer ID to match the token actor",
    );

    const marker = makeRunMarker();
    process.stdout.write(`WorkGraph live run marker: ${marker}\n`);
    const tracked = [];
    t.after(async () => {
      await cleanupRun(client, {
        marker,
        actorId: viewer.id,
        tracked,
      });
    });

    const parent = await client.createIssue({
      repositoryId: viewer.repositoryId,
      title: parentTitle(marker),
      body: parentBody(marker),
      clientMutationId: `${marker}:parent`,
    });
    tracked.push({ kind: "parent", number: parent.number });

    const child = await client.createIssue({
      repositoryId: viewer.repositoryId,
      title: childTitle(marker),
      body: TASK_BODY,
      issueTypeId: config.taskTypeId,
      parentIssueId: parent.id,
      clientMutationId: `${marker}:child`,
    });
    tracked.push({ kind: "child", number: child.number });

    const [graphParent, graphChild, restParent, restChild, nativeParent] =
      await Promise.all([
        client.graphIssue(parent.number),
        client.graphIssue(child.number),
        client.issue(parent.number),
        client.issue(child.number),
        client.parent(child.number),
      ]);
    assert.equal(graphParent.issueType, null);
    assert.equal(restParent.type, null);
    assert.deepEqual(graphChild.issueType, {
      id: config.taskTypeId,
      name: "WorkGraphTask",
    });
    assert.equal(restChild.type?.node_id, config.taskTypeId);
    assert.equal(restChild.type?.name, "WorkGraphTask");
    assert.deepEqual(graphChild.parent, {
      id: parent.id,
      number: parent.number,
    });
    assert.equal(nativeParent.node_id, parent.id);
    assert.equal(nativeParent.number, parent.number);
    assert.deepEqual(graphParent.subIssues.nodes, [
      { id: child.id, number: child.number },
    ]);
    assert.equal(graphParent.author.login, viewer.login);
    assert.equal(graphChild.author.login, viewer.login);
    assert.equal(restParent.user.id, viewer.id);
    assert.equal(restChild.user.id, viewer.id);
    assert.equal(graphChild.body, TASK_BODY);
    assert.deepEqual(parseTask(graphChild.body), TASK_PAYLOAD);

    const leaseValidator = await startLeaseValidator();
    t.after(() => leaseValidator.close());
    const refs = references(parent, child);
    const assignmentInput = {
      ...refs,
      agentId: "issue-validator",
    };

    let before = commentsSnapshot(await client.comments(child.number));
    let response = await invokeReporter(
      config,
      leaseValidator,
      "submit_task_assignment",
      { ...assignmentInput, taskIssueNodeId: `${child.id}_wrong` },
    );
    assertToolError(response, /requested fixed-repository Issue/);
    assert.deepEqual(
      commentsSnapshot(await client.comments(child.number)),
      before,
    );

    response = await invokeReporter(
      config,
      leaseValidator,
      "submit_task_assignment",
      { ...assignmentInput, parentIssueNodeId: `${parent.id}_wrong` },
    );
    assertToolError(response, /requested open Issue/);
    assert.deepEqual(
      commentsSnapshot(await client.comments(child.number)),
      before,
    );

    response = await invokeReporter(
      { ...config, taskTypeId: "IT_wrong" },
      leaseValidator,
      "submit_task_assignment",
      assignmentInput,
    );
    assertToolError(response, /configured exact WorkGraphTask type/);
    assert.deepEqual(
      commentsSnapshot(await client.comments(child.number)),
      before,
    );

    response = await invokeReporter(
      config,
      leaseValidator,
      "submit_task_assignment",
      { ...assignmentInput, agentId: "issue-info-requester" },
    );
    assertToolError(response, /does not match taskType/);
    assert.deepEqual(
      commentsSnapshot(await client.comments(child.number)),
      before,
    );

    const assignment = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_assignment",
        assignmentInput,
      ),
    );
    assert.equal(assignment.reconciled, false);
    const assignmentRetry = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_assignment",
        assignmentInput,
      ),
    );
    assert.deepEqual(assignmentRetry, {
      commentNodeId: assignment.commentNodeId,
      reconciled: true,
    });
    let comments = await client.comments(child.number);
    let assignmentComment = oneMarkerComment(
      comments,
      MARKERS.assignment,
    );
    assert.equal(
      assignmentComment.body,
      formatAssignment("issue-validator"),
    );
    assert.equal(assignmentComment.user.id, viewer.id);
    assert.equal((await client.comments(parent.number)).length, 0);

    const firstLease = leaseFor({
      marker,
      attempt: 1,
      child,
      assignmentCommentNodeId: assignment.commentNodeId,
    });
    leaseValidator.register(firstLease);
    const passingResult = {
      taskType: "validate-issue",
      leaseId: firstLease.leaseId,
      outcome: "succeeded",
      summary: "Both required parent fields are present.",
      result: {
        criteria: [
          {
            criterion: CRITERIA[0],
            passed: true,
            evidence: "The parent title is non-empty.",
          },
          {
            criterion: CRITERIA[1],
            passed: true,
            evidence: "The parent body is non-empty.",
          },
        ],
      },
    };
    const resultInput = {
      ...refs,
      ...leaseArguments(firstLease),
      workResult: passingResult,
    };

    before = commentsSnapshot(await client.comments(child.number));
    const missingLeaseField = { ...resultInput };
    delete missingLeaseField.expiresAt;
    for (const input of [
      missingLeaseField,
      { ...resultInput, unexpectedLeaseField: "nope" },
    ]) {
      response = await invokeReporter(
        config,
        leaseValidator,
        "submit_task_result",
        input,
      );
      assertToolError(response, /properties must be exactly/);
      assert.deepEqual(
        commentsSnapshot(await client.comments(child.number)),
        before,
      );
    }
    for (const [input, expected] of [
      [
        { ...resultInput, assignmentCommentNodeId: "IC_wrong" },
        /exact Assignment\/v1/,
      ],
      [
        { ...resultInput, agentId: "issue-info-requester" },
        /exact Assignment\/v1/,
      ],
      [
        { ...resultInput, slotId: "issue-validator/99" },
        /HTTP 409/,
      ],
      [
        {
          ...resultInput,
          workResult: { ...passingResult, leaseId: "wrong-lease" },
        },
        /must match the active dispatch Lease/,
      ],
      [
        {
          ...resultInput,
          expiresAt: iso(Date.now() - 1_000),
          acquiredAt: iso(Date.now() - 60_000),
        },
        /expired/,
      ],
    ]) {
      response = await invokeReporter(
        config,
        leaseValidator,
        "submit_task_result",
        input,
      );
      assertToolError(response, expected);
      assert.deepEqual(
        commentsSnapshot(await client.comments(child.number)),
        before,
      );
    }
    for (const [mode, expected] of [
      ["unauthorized", /HTTP 401/],
      ["malformed", /not JSON/],
      ["extra", /properties must be exactly/],
      ["mismatch", /does not match the dispatch/],
    ]) {
      leaseValidator.queueMode(mode);
      response = await invokeReporter(
        config,
        leaseValidator,
        "submit_task_result",
        resultInput,
      );
      assertToolError(response, expected);
      assert.deepEqual(
        commentsSnapshot(await client.comments(child.number)),
        before,
      );
    }

    const validationsBeforeResult = leaseValidator.count(firstLease.leaseId);
    const result = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_result",
        resultInput,
      ),
    );
    assert.equal(result.reconciled, false);
    assert.equal(result.revised, false);
    assert.equal(
      leaseValidator.count(firstLease.leaseId),
      validationsBeforeResult + 1,
    );
    const resultRetry = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_result",
        resultInput,
      ),
    );
    assert.equal(resultRetry.reconciled, true);
    assert.equal(
      leaseValidator.count(firstLease.leaseId),
      validationsBeforeResult + 1,
    );
    comments = await client.comments(child.number);
    let resultComment = oneMarkerComment(comments, MARKERS.result);
    assert.equal(resultComment.node_id, result.commentNodeId);
    assert.equal(resultComment.body, formatTaskResult(passingResult));
    assert.equal(resultComment.user.id, viewer.id);

    const snapshot = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "get_result_snapshot",
        refs,
      ),
    );
    assert.deepEqual(snapshot, {
      resultCommentNodeId: result.commentNodeId,
      resultBodyDigest: resultDigest(formatTaskResult(passingResult)),
      workResult: passingResult,
    });

    const feedbackText = "Clarify the body criterion evidence.";
    before = commentsSnapshot(comments);
    for (const [input, expected] of [
      [{
        ...refs,
        resultCommentNodeId: "IC_wrong",
        resultBodyDigest: snapshot.resultBodyDigest,
        feedback: feedbackText,
      }, /current Result/],
      [{
        ...refs,
        resultCommentNodeId: snapshot.resultCommentNodeId,
        resultBodyDigest: `sha256:${"0".repeat(64)}`,
        feedback: feedbackText,
      }, /stale Result digest/],
      [{
        ...refs,
        resultCommentNodeId: snapshot.resultCommentNodeId,
        resultBodyDigest: "not-a-digest",
        feedback: feedbackText,
      }, /sha256/],
    ]) {
      response = await invokeReporter(
        config,
        leaseValidator,
        "submit_task_feedback",
        input,
      );
      assertToolError(response, expected);
      assert.deepEqual(
        commentsSnapshot(await client.comments(child.number)),
        before,
      );
    }

    const feedbackInput = {
      ...refs,
      resultCommentNodeId: snapshot.resultCommentNodeId,
      resultBodyDigest: snapshot.resultBodyDigest,
      feedback: feedbackText,
    };
    const feedback = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_feedback",
        feedbackInput,
      ),
    );
    assert.equal(feedback.reconciled, false);
    const feedbackRetry = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_feedback",
        feedbackInput,
      ),
    );
    assert.equal(feedbackRetry.reconciled, true);
    comments = await client.comments(child.number);
    let feedbackComment = oneMarkerComment(comments, MARKERS.feedback);
    assert.equal(feedbackComment.node_id, feedback.feedbackCommentNodeId);
    assert.equal(
      feedbackComment.body,
      formatFeedback(
        snapshot.resultCommentNodeId,
        snapshot.resultBodyDigest,
        feedbackText,
      ),
    );
    assert.equal(feedbackComment.user.id, viewer.id);

    const secondLease = leaseFor({
      marker,
      attempt: 2,
      child,
      assignmentCommentNodeId: assignment.commentNodeId,
      acquiredAt: Date.parse(feedbackComment.updated_at) + 1_000,
    });
    leaseValidator.register(secondLease);
    const revisedResult = {
      ...passingResult,
      leaseId: secondLease.leaseId,
      summary: "Both required parent fields are present; evidence clarified.",
      result: {
        criteria: [
          passingResult.result.criteria[0],
          {
            ...passingResult.result.criteria[1],
            evidence:
              "The canonical integration marker makes the parent body non-empty.",
          },
        ],
      },
    };
    const revisionInput = {
      ...refs,
      ...leaseArguments(secondLease),
      feedbackCommentNodeId: feedbackComment.node_id,
      feedbackUpdatedAt: feedbackComment.updated_at,
      resultCommentNodeId: snapshot.resultCommentNodeId,
      resultBodyDigest: snapshot.resultBodyDigest,
      workResult: revisedResult,
    };
    const revision = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_result",
        revisionInput,
      ),
    );
    assert.equal(revision.revised, true);
    assert.equal(revision.commentNodeId, snapshot.resultCommentNodeId);
    const revisionRetry = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_result",
        revisionInput,
      ),
    );
    assert.equal(revisionRetry.reconciled, true);
    comments = await client.comments(child.number);
    resultComment = oneMarkerComment(comments, MARKERS.result);
    assert.equal(resultComment.node_id, snapshot.resultCommentNodeId);
    assert.equal(resultComment.body, formatTaskResult(revisedResult));

    const revisedFeedbackInput = {
      ...feedbackInput,
      resultBodyDigest: resultDigest(formatTaskResult(revisedResult)),
    };
    const revisedFeedback = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_feedback",
        revisedFeedbackInput,
      ),
    );
    assert.equal(revisedFeedback.revised, true);
    assert.equal(
      revisedFeedback.feedbackCommentNodeId,
      feedback.feedbackCommentNodeId,
    );
    const revisedFeedbackRetry = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_task_feedback",
        revisedFeedbackInput,
      ),
    );
    assert.equal(revisedFeedbackRetry.reconciled, true);

    const acceptanceInput = {
      ...refs,
      resultCommentNodeId: revision.commentNodeId,
      resultBodyDigest: revision.resultBodyDigest,
      summary: "The revised Result is satisfactory.",
    };
    before = commentsSnapshot(await client.comments(child.number));
    for (const [input, expected] of [
      [
        {
          ...acceptanceInput,
          resultBodyDigest: `sha256:${"0".repeat(64)}`,
        },
        /stale Result ID or digest/,
      ],
      [
        { ...acceptanceInput, resultCommentNodeId: "IC_wrong" },
        /stale Result ID or digest/,
      ],
      [
        { ...acceptanceInput, resultBodyDigest: "not-a-digest" },
        /sha256/,
      ],
    ]) {
      response = await invokeReporter(
        config,
        leaseValidator,
        "submit_result_acceptance",
        input,
      );
      assertToolError(response, expected);
      assert.deepEqual(
        commentsSnapshot(await client.comments(child.number)),
        before,
      );
    }
    const acceptance = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_result_acceptance",
        acceptanceInput,
      ),
    );
    assert.equal(acceptance.reconciled, false);
    const acceptanceRetry = assertToolSuccess(
      await invokeReporter(
        config,
        leaseValidator,
        "submit_result_acceptance",
        acceptanceInput,
      ),
    );
    assert.deepEqual(acceptanceRetry, {
      commentNodeId: acceptance.commentNodeId,
      reconciled: true,
    });

    response = await invokeReporter(
      config,
      leaseValidator,
      "submit_task_feedback",
      revisedFeedbackInput,
    );
    assertToolError(response, /cannot target an accepted Result/);

    comments = await client.comments(child.number);
    assignmentComment = oneMarkerComment(comments, MARKERS.assignment);
    resultComment = oneMarkerComment(comments, MARKERS.result);
    feedbackComment = oneMarkerComment(comments, MARKERS.feedback);
    const acceptanceComment = oneMarkerComment(
      comments,
      MARKERS.acceptance,
    );
    assert.equal(
      assignmentComment.body,
      formatAssignment("issue-validator"),
    );
    assert.equal(resultComment.body, formatTaskResult(revisedResult));
    assert.equal(
      feedbackComment.body,
      formatFeedback(
        revision.commentNodeId,
        revision.resultBodyDigest,
        feedbackText,
      ),
    );
    assert.equal(
      acceptanceComment.body,
      formatAcceptance({
        resultCommentNodeId: revision.commentNodeId,
        resultBodyDigest: revision.resultBodyDigest,
        summary: acceptanceInput.summary,
      }),
    );
    for (const comment of [
      assignmentComment,
      resultComment,
      feedbackComment,
      acceptanceComment,
    ]) {
      assert.equal(comment.user.id, viewer.id);
    }
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(MARKERS).map(([name, markerName]) => [
          name,
          markerComments(comments, markerName).length,
        ]),
      ),
      { assignment: 1, result: 1, feedback: 1, acceptance: 1 },
    );
    assert.equal((await client.issue(child.number)).state, "open");
    assert.equal((await client.issue(parent.number)).state, "open");
  },
);
