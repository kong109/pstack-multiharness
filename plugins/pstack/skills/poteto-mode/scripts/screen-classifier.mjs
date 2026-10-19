const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_S = 5;

const INSTRUCTIONS = "The state is the visible text of a terminal pane that runs an AI coding agent's TUI, such as Claude Code or Codex. Classify what the pane is waiting for right now.";

export const SCREEN_LABELS = {
  turn_finished: {
    criteria: "The agent's turn is over. Its last output is complete and the screen ends at an empty input prompt that waits for the user's next message. No spinner, elapsed-time counter, or interrupt hint shows, no menu of options is open, and the last message does not ask the user anything.",
    minConfidence: 0.9,
    settle: "rest",
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
    criteria: "The agent is still busy: a spinner, an elapsed-time or token counter, an interrupt hint such as 'esc to interrupt', a running tool, or streaming output shows the turn is in progress.",
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
