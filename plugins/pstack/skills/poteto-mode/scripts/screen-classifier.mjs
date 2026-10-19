const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_S = 5;

const INSTRUCTIONS = "The state is the visible text of a terminal pane that runs an AI coding agent's TUI, such as Claude Code or Codex. Classify what the pane is waiting for right now. The input box and the footer under it, with the model, cost, context, permission mode, and background agent count, are drawn in every state, so they say nothing. Judge by the last status line above the input box, and ignore any tip or hint line between them, such as one about tmux focus-events: an activity word ending in '…' with an elapsed time in parentheses means working, a past-tense summary or no status line after the agent's reply means the turn is over, and a screen with no user message on it means no turn has started.";

export const SCREEN_LABELS = {
  turn_finished: {
    criteria: "The agent's turn is over. The user sent at least one message, the agent's reply follows it, and the screen ends at an empty input prompt that waits for the next message. A welcome banner may still show above the first message. A past-tense summary such as 'Churned for 8s · done 3:22 PM' or 'Worked for 5s • 3:18 PM' follows the agent's last message. No menu of options is open, and the last message does not ask the user anything.",
    minConfidence: 0.9,
    settle: "rest",
  },
  not_started: {
    criteria: "No turn has started. The screen holds only startup text, such as a version line, a logo, a working directory, or suggested commands, above an empty input prompt that may show a placeholder suggestion. No user message appears anywhere on the screen, and the agent has written no reply.",
    minConfidence: 0.7,
    settle: "stalled",
  },
  dialog_open: {
    criteria: "A dialog or menu waits for a keypress: a tool, command, or edit approval, a permission request, a folder trust prompt, a login or authentication screen, or a numbered or highlighted list of options to choose from.",
    minConfidence: 0.7,
    settle: "blocked",
  },
  asked_in_terminal: {
    criteria: "The turn is over and the agent's last message asks the user a question or for a decision in plain text, and the input prompt waits for a typed reply. No menu of options is open.",
    minConfidence: 0.7,
    settle: "quiet",
  },
  still_working: {
    criteria: "The agent is still busy. The user's last message has no finished answer under it yet, and a status line names an activity in progress with a running timer, such as '✢ Bootstrapping… (2s · thinking)' or '• Working (2s • esc to interrupt)', or a tool is running or output is streaming.",
    minConfidence: null,
    settle: null,
  },
};

export const classifierEnabled = (env) => Boolean(env.TYPESAFE_API_KEY) && env.PSTACK_SCREEN_CLASSIFIER !== "off";

// curl's config syntax shares JSON's \\ and \" escapes, and JSON.stringify leaves no raw newline to escape.
const quote = (value) => `"${value.replace(/[\\"]/g, "\\$&")}"`;

export function classifyScreen(screen, { runner, env }) {
  if (!classifierEnabled(env)) return null;
  const body = JSON.stringify({
    model: "jev-latest",
    state: screen,
    questions: {
      screen: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria: Object.fromEntries(Object.entries(SCREEN_LABELS).map(([label, { criteria }]) => [label, criteria])),
      },
    },
  });
  // The key and the screen go through stdin, because argv is visible to every user in ps.
  const config = [
    `url = ${quote(ENDPOINT)}`,
    `header = ${quote(`Authorization: Bearer ${env.TYPESAFE_API_KEY}`)}`,
    `header = ${quote("Content-Type: application/json")}`,
    `data-binary = ${quote(body)}`,
  ].join("\n") + "\n";
  const r = runner("curl", ["-sS", "--max-time", String(TIMEOUT_S), "--config", "-"], { timeoutMs: (TIMEOUT_S + 2) * 1000, input: config });
  if (r.status !== 0) return null;
  let answer;
  try { answer = JSON.parse(r.stdout).answers?.screen; } catch { return null; }
  if (!Object.hasOwn(SCREEN_LABELS, answer?.choice) || typeof answer.confidence !== "number") return null;
  return { label: answer.choice, confidence: answer.confidence };
}

export function screenSettle(classified) {
  if (!classified) return null;
  const { minConfidence, settle } = SCREEN_LABELS[classified.label];
  return settle && classified.confidence >= minConfidence ? settle : null;
}
