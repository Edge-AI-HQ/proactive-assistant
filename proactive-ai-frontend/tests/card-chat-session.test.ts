import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatRequestBody,
  shouldBootstrapCardChat,
} from "../src/components/chat/card-chat-session";

test("card chat bootstrap request only sends card context", () => {
  const body = buildChatRequestBody({
    sessionKey: "agent:main:proactive-ai:chat:card:test",
    cardContextJson: '{"title":"Test"}',
    includeCardContext: true,
  });

  assert.deepEqual(body, {
    sessionKey: "agent:main:proactive-ai:chat:card:test",
    cardContext: '{"title":"Test"}',
  });
});

test("first user message keeps text and can carry card context as fallback", () => {
  const body = buildChatRequestBody({
    sessionKey: "agent:main:proactive-ai:chat:card:test",
    userText: "确认，到时候我需要做什么",
    cardContextJson: '{"title":"Test"}',
    includeCardContext: true,
  });

  assert.deepEqual(body, {
    sessionKey: "agent:main:proactive-ai:chat:card:test",
    message: "确认，到时候我需要做什么",
    cardContext: '{"title":"Test"}',
  });
});

test("after bootstrap user message no longer repeats card context", () => {
  const body = buildChatRequestBody({
    sessionKey: "agent:main:proactive-ai:chat:card:test",
    userText: "确认",
    cardContextJson: '{"title":"Test"}',
    includeCardContext: false,
  });

  assert.deepEqual(body, {
    sessionKey: "agent:main:proactive-ai:chat:card:test",
    message: "确认",
  });
});

test("bootstrap only runs for new card sessions with card context", () => {
  assert.equal(
    shouldBootstrapCardChat({
      hasExistingHistory: false,
      hasCardContext: true,
      alreadyBootstrapped: false,
    }),
    true,
  );

  assert.equal(
    shouldBootstrapCardChat({
      hasExistingHistory: true,
      hasCardContext: true,
      alreadyBootstrapped: false,
    }),
    false,
  );

  assert.equal(
    shouldBootstrapCardChat({
      hasExistingHistory: false,
      hasCardContext: true,
      alreadyBootstrapped: true,
    }),
    false,
  );
});
