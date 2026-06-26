/**
 * Monday "kickoff → release group" automation
 * ------------------------------------------------------------------
 * WHAT IT DOES
 *   When the item named "Campaign kickoff + brief finalized" on the Work
 *   board has its Status set to "Done", every OTHER item in that same group
 *   is moved from Backlog to "To Do". This is the step native monday.com
 *   blocks cannot do (no "update all items in the triggering item's group"
 *   action), so we do it with a webhook + the monday API.
 *
 *   Because the webhook payload includes groupId and pulseName directly,
 *   this works generically for ANY group Claude creates by copying a
 *   task-template group — no group needs to be hard-coded.
 *
 * ARCHITECTURE
 *   monday board ──(status webhook)──▶ this endpoint ──(GraphQL)──▶ monday API
 *
 * SETUP (3 steps — all doable from Cursor)
 *   1. Host this file somewhere with a public HTTPS URL (Render, Railway,
 *      Cloudflare Workers, a small Fly.io app, or a Lambda behind API GW).
 *        npm i express node-fetch@2
 *        MONDAY_TOKEN=xxxx node monday-kickoff-group-reset.js
 *   2. Put your monday personal API token in the MONDAY_TOKEN env var
 *      (monday.com → avatar → Developers → My Access Tokens).
 *   3. Register the webhook ONCE (see registerWebhook() at the bottom — run
 *      `node monday-kickoff-group-reset.js --register https://your-url/webhook`).
 *      It subscribes to "change_status_column_value" on the Work board only.
 *
 * BOARD CONSTANTS (from your live Work board, 26 Jun 2026)
 */
const BOARD_ID         = 18416922632;          // Work board
const STATUS_COLUMN_ID = "color_mm45tfhx";      // "Status" column
const KICKOFF_NAME     = "Campaign kickoff + brief finalized";
const DONE_LABEL       = "Done";
const TODO_LABEL       = "To Do";
// Only items currently in Backlog are released. We deliberately do NOT
// touch items already In Progress / In Review / Done / Blocked, so re-runs
// (or a re-opened kickoff) never clobber work that's underway.
const RELEASE_FROM     = new Set(["Backlog"]);

const express = require("express");
const fetch   = require("node-fetch");

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const API_URL      = "https://api.monday.com/v2";

async function monday(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": MONDAY_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/** Fetch every item in a group with its current status label. */
async function getGroupItems(boardId, groupId) {
  const q = `
    query ($boardId: [ID!], $groupId: [String!]) {
      boards (ids: $boardId) {
        groups (ids: $groupId) {
          items_page (limit: 200) {
            items {
              id
              name
              column_values (ids: ["${STATUS_COLUMN_ID}"]) { text }
            }
          }
        }
      }
    }`;
  const data = await monday(q, { boardId: [String(boardId)], groupId: [groupId] });
  const group = data.boards?.[0]?.groups?.[0];
  return group ? group.items_page.items : [];
}

/** Set one item's Status to "To Do". */
async function setToDo(boardId, itemId) {
  const m = `
    mutation ($boardId: ID!, $itemId: ID!, $val: String!) {
      change_simple_column_value (
        board_id: $boardId, item_id: $itemId,
        column_id: "${STATUS_COLUMN_ID}", value: $val
      ) { id }
    }`;
  return monday(m, { boardId: String(boardId), itemId: String(itemId), val: TODO_LABEL });
}

/** Core logic: release the rest of the kickoff item's group. */
async function releaseGroup(boardId, groupId, kickoffItemId) {
  const items = await getGroupItems(boardId, groupId);
  const targets = items.filter(it =>
    String(it.id) !== String(kickoffItemId) &&         // skip the kickoff row itself
    it.name !== KICKOFF_NAME &&                          // belt-and-suspenders on name
    RELEASE_FROM.has(it.column_values?.[0]?.text || "") // only release Backlog items
  );
  for (const it of targets) await setToDo(boardId, it.id);
  console.log(`Released ${targets.length}/${items.length} items in group ${groupId}`);
  return targets.length;
}

// ---- Webhook endpoint ------------------------------------------------------
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const body = req.body || {};
  // monday handshake: echo the challenge on first registration
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });

  const e = body.event || {};
  try {
    const isStatusCol = e.columnId === STATUS_COLUMN_ID;
    const isDone      = e.value?.label?.text === DONE_LABEL;
    const isKickoff   = e.pulseName === KICKOFF_NAME;
    if (isStatusCol && isDone && isKickoff) {
      await releaseGroup(e.boardId, e.groupId, e.pulseId);
    }
  } catch (err) {
    console.error("reset failed:", err.message);
  }
  // Always 200 quickly so monday doesn't retry/disable the webhook.
  res.sendStatus(200);
});

// ---- One-time webhook registration ----------------------------------------
async function registerWebhook(url) {
  const m = `
    mutation ($boardId: ID!, $url: String!) {
      create_webhook (board_id: $boardId, url: $url, event: change_status_column_value) {
        id board_id
      }
    }`;
  const data = await monday(m, { boardId: String(BOARD_ID), url });
  console.log("Webhook created:", data.create_webhook);
}

if (process.argv[2] === "--register") {
  registerWebhook(process.argv[3]).catch(e => { console.error(e); process.exit(1); });
} else {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`kickoff-reset listening on :${port}`));
}
