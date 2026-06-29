/**
 * Monday "kickoff → release group" automation  (v2 — with /health + logging)
 * ------------------------------------------------------------------
 * When the item "Campaign kickoff + brief finalized" on the Work board is set
 * to Done, every OTHER Backlog item in that same group is moved to "To Do".
 *
 * v2 changes (diagnostics):
 *   - GET  /        -> simple "up" check
 *   - GET  /health  -> calls the Monday API with your token and reports whether
 *                      the token is present and valid (so we can confirm setup)
 *   - Webhook now LOGS every event received and logs real errors instead of
 *     swallowing them silently.
 *
 * SETUP RECAP
 *   npm i express node-fetch@2
 *   env var MONDAY_TOKEN = your monday personal API token
 *   Start command: node monday-kickoff-group-reset.js
 *   Register once: node monday-kickoff-group-reset.js --register https://URL/webhook
 */
const BOARD_ID         = 18416922632;          // Work board
const STATUS_COLUMN_ID = "color_mm45tfhx";      // "Status" column
const KICKOFF_NAME     = "Campaign kickoff + brief finalized";
const DONE_LABEL       = "Done";
const TODO_LABEL       = "To Do";
const RELEASE_FROM     = new Set(["Backlog"]);  // only release Backlog items

const express = require("express");
const fetch   = require("node-fetch");

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const API_URL      = "https://api.monday.com/v2";

async function monday(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": MONDAY_TOKEN || "",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getGroupItems(boardId, groupId) {
  const q = `
    query ($boardId: [ID!], $groupId: [String!]) {
      boards (ids: $boardId) {
        groups (ids: $groupId) {
          items_page (limit: 200) {
            items { id name column_values (ids: ["${STATUS_COLUMN_ID}"]) { text } }
          }
        }
      }
    }`;
  const data = await monday(q, { boardId: [String(boardId)], groupId: [groupId] });
  return data.boards?.[0]?.groups?.[0]?.items_page?.items || [];
}

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

async function releaseGroup(boardId, groupId, kickoffItemId) {
  const items = await getGroupItems(boardId, groupId);
  const targets = items.filter(it =>
    String(it.id) !== String(kickoffItemId) &&
    it.name !== KICKOFF_NAME &&
    RELEASE_FROM.has(it.column_values?.[0]?.text || "")
  );
  for (const it of targets) await setToDo(boardId, it.id);
  console.log(`[reset] released ${targets.length}/${items.length} items in group ${groupId}`);
  return targets.length;
}

const app = express();
app.use(express.json());

// Liveness
app.get("/", (_req, res) => res.status(200).send("kickoff-reset up"));

// Token / API health check — open this in a browser to confirm setup
app.get("/health", async (_req, res) => {
  if (!MONDAY_TOKEN) return res.status(200).json({ tokenPresent: false, tokenValid: false, note: "MONDAY_TOKEN env var is not set" });
  try {
    const data = await monday(`query { me { name email } }`);
    res.status(200).json({ tokenPresent: true, tokenValid: true, authedAs: data.me });
  } catch (err) {
    res.status(200).json({ tokenPresent: true, tokenValid: false, error: err.message });
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body || {};
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });

  const e = body.event || {};
  console.log(`[webhook] pulse="${e.pulseName}" col=${e.columnId} label="${e.value?.label?.text}" group=${e.groupId}`);
  try {
    if (e.columnId === STATUS_COLUMN_ID &&
        e.value?.label?.text === DONE_LABEL &&
        e.pulseName === KICKOFF_NAME) {
      await releaseGroup(e.boardId, e.groupId, e.pulseId);
    } else {
      console.log("[webhook] ignored (not the kickoff item reaching Done)");
    }
  } catch (err) {
    console.error("[webhook] reset FAILED:", err.message);
  }
  res.sendStatus(200);
});

async function registerWebhook(url) {
  const m = `
    mutation ($boardId: ID!, $url: String!) {
      create_webhook (board_id: $boardId, url: $url, event: change_status_column_value) { id board_id }
    }`;
  console.log(await monday(m, { boardId: String(BOARD_ID), url }));
}

if (process.argv[2] === "--register") {
  registerWebhook(process.argv[3]).catch(e => { console.error(e); process.exit(1); });
} else {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`kickoff-reset listening on :${port}`));
}
