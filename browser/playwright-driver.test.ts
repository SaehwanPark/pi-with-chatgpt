/**
 * M3 driver tests. Playwright is never imported here: the driver receives its page objects through an
 * injected launcher, so a scripted conversation thread is enough to exercise the decisions that actually
 * carry risk — which answer belongs to this turn, and which page counts as ChatGPT at all.
 *
 * The thread is mutated *between polls* from the injected `sleep`, because that is the only way to express
 * "the old answer was already on screen when we typed". A fixture that described one frozen page could not
 * distinguish this turn's advice from last turn's, which is exactly the bug these tests exist to keep fixed.
 */
import { describe, expect, it } from "vitest";

import { CHATGPT_URLS } from "./chatgpt-dom.js";
import { createAdviserProfile } from "./profile.js";
import {
  PlaywrightAdviserDriver,
  type PlaywrightLaunchResult,
  type PlaywrightLauncher,
} from "./playwright-driver.js";
import type { ConsultationRequest } from "./runtime-types.js";

// The driver's real selector sets live in `chatgpt-dom.ts`; these are the primary candidates it tries
// first. Keying the fake thread by them keeps the fake honest without re-deriving the fallback order.
const COMPOSER = '[data-testid="conversation-composer"]';
const SEND = '[data-testid="send-button"]';
const USER = '[data-testid="user-message"]';
const ASSISTANT = '[data-testid="conversation-turn-assistant"]';

const PROFILE = createAdviserProfile({
  stateRoot: "/home/ada/.pi/agent/pi-with-chatgpt",
  userDataDir: "/home/ada/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile",
});

const TURN: ConsultationRequest = {
  consultationId: "cons-0123456789abcdef",
  prompt: "Review the checkpoint at HEAD for architecture risk.",
  modelId: "gpt-5.5",
};

interface FakeNode {
  readonly text: string;
  readonly visible: boolean;
  /** Only `href` is read (M4 parses Project/conversation ids out of links). */
  readonly href?: string;
}

/** Mutable on purpose: the thread has to change while the driver is polling it. */
type FakeThread = Record<string, FakeNode[]>;

function node(text: string): FakeNode {
  return { text, visible: true };
}

function fakePage(thread: FakeThread, startUrl: string, title: () => Promise<string> = () => Promise.resolve("ChatGPT")) {
  const navigations: string[] = [];
  const typed: string[] = [];
  const clicked: string[] = [];
  let currentUrl = startUrl;
  const page = {
    closed: false,
    isClosed: (): boolean => page.closed,
    url: () => currentUrl,
    title,
    goto: (url: string) => {
      // A real page lands where it was told to, which is what lets a test assert the target.
      navigations.push(url);
      currentUrl = url;
      return Promise.resolve(undefined);
    },
    waitForLoadState: () => Promise.resolve(undefined),
    keyboard: { press: () => Promise.resolve() },
    frames: () => [],
    close: () => {
      page.closed = true;
      return Promise.resolve();
    },
    locator: (selector: string) => {
      // Read per call: a locator made before a DOM change must not see the thread as it was.
      const nodes = thread[selector] ?? [];
      const element = (index: number) => {
        const target: FakeNode | undefined = nodes[index];
        return {
          isVisible: () => Promise.resolve(target !== undefined && target.visible),
          innerText: () => Promise.resolve(target?.text ?? ""),
          inputValue: () => Promise.resolve(target?.text ?? ""),
          getAttribute: (name: string) =>
            Promise.resolve(name === "href" ? (target?.href ?? null) : null),
          click: () => {
            clicked.push(target?.text ?? "<no node>");
            return Promise.resolve();
          },
          fill: (text: string) => {
            typed.push(text);
            return Promise.resolve();
          },
          pressSequentially: (text: string) => {
            typed.push(text);
            return Promise.resolve();
          },
        };
      };
      return {
        count: () => Promise.resolve(nodes.length),
        nth: (index: number) => element(index),
        first: () => element(0),
      };
    },
  };
  return { clicked, navigations, page, typed };
}

function launcherFor(page: ReturnType<typeof fakePage>["page"]): PlaywrightLauncher {
  const context = {
    pages: () => [page],
    newPage: () => Promise.resolve(page),
    close: () => Promise.resolve(),
  };
  // Annotated rather than cast: the fake satisfies the real launch contract as written, and that is the
  // point — the driver cannot be fed a page object the shipped launcher could not produce.
  const launched: PlaywrightLaunchResult = { context, chromeVersion: "152.0.0.0" };
  return () => Promise.resolve(launched);
}

async function startedDriver(options: {
  readonly thread: FakeThread;
  readonly url?: string;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly title?: () => Promise<string>;
}) {
  const { clicked, navigations, page, typed } = fakePage(
    options.thread,
    options.url ?? "https://chatgpt.com/",
    options.title,
  );
  const driver = new PlaywrightAdviserDriver({
    profile: PROFILE,
    launch: launcherFor(page),
    pollIntervalMs: options.pollIntervalMs ?? 1,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  await driver.start({ purpose: "consultation" });
  return { clicked, driver, navigations, typed };
}

describe("PlaywrightAdviserDriver.isHealthy", () => {
  it("reports a renderer that does not answer before the health deadline as unhealthy", async () => {
    const never = () => new Promise<string>(() => undefined);
    const { driver } = await startedDriver({ thread: {}, title: never, sleep: () => Promise.resolve() });

    await expect(driver.isHealthy()).resolves.toBe(false);
  });
});

/** Drives scripted thread changes from the polling delay: `step` runs once per poll that slept. */
function scriptedSleep(step: (tick: number) => void): (ms: number) => Promise<void> {
  let tick = 0;
  return (_ms: number) => {
    tick += 1;
    step(tick);
    return Promise.resolve();
  };
}

describe("PlaywrightAdviserDriver.askAndAwaitTurn", () => {
  it("reads the answer this turn produced, not the one already on screen", async () => {
    // The regression: the thread already held an answer, and turn completion treated any visible answer as
    // the new one, so yesterday's advice was recorded against this consultationId.
    const thread: FakeThread = {
      [COMPOSER]: [node("")],
      [SEND]: [node("")],
      [USER]: [],
      [ASSISTANT]: [node("earlier advice")],
    };
    const sleep = scriptedSleep((tick) => {
      if (tick === 1) thread[USER]!.push(node("Review the checkpoint at HEAD for architecture risk."));
      if (tick === 2) thread[ASSISTANT]!.push(node("this turn's advice"));
    });

    const { driver, typed } = await startedDriver({ thread, sleep });
    const outcome = await driver.askAndAwaitTurn(TURN);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable: the turn completes");
    expect(outcome.text).toBe("this turn's advice");
    // The brief is typed as data and never becomes a selector or a URL.
    expect(typed).toContain(TURN.prompt);
  });

  it("never credits a previous answer to this consultation", async () => {
    // Our message is on screen and an answer is on screen — but the answer count never grew, so the turn
    // did not complete. Returning "earlier advice" here would be the confident-nonsense failure mode.
    const thread: FakeThread = {
      [COMPOSER]: [node("")],
      [SEND]: [node("")],
      [USER]: [node("Review the checkpoint at HEAD for architecture risk.")],
      [ASSISTANT]: [node("earlier advice")],
    };
    const { driver } = await startedDriver({ thread });
    const outcome = await driver.askAndAwaitTurn({ ...TURN, timeoutMs: 150 });

    expect(outcome).toEqual({ ok: false, failure: "generation-timeout" });
  });

  it("reports a missing composer instead of typing somewhere arbitrary", async () => {
    const thread: FakeThread = { [COMPOSER]: [], [SEND]: [], [USER]: [], [ASSISTANT]: [] };
    const { driver } = await startedDriver({ thread });
    const outcome = await driver.askAndAwaitTurn({ ...TURN, timeoutMs: 20 });

    expect(outcome).toEqual({ ok: false, failure: "composer-missing" });
  });
});

describe("PlaywrightAdviserDriver.openChatGPT", () => {
  it("navigates only to the ChatGPT home surface", async () => {
    // INV-02/INV-11: the driver has no notion of a caller-supplied URL, and this is the only navigation
    // it can perform. A page-controlled or brief-controlled target would be a second transport.
    const thread: FakeThread = {
      [COMPOSER]: [node("")],
      [SEND]: [node("")],
      [USER]: [],
      [ASSISTANT]: [],
    };
    const { driver, navigations } = await startedDriver({ thread, url: "about:blank" });
    const observation = await driver.openChatGPT();

    expect(navigations).toEqual([CHATGPT_URLS.home]);
    expect(observation.state).toBe("conversation-ready");
  });
});

describe("PlaywrightAdviserDriver.runExclusive", () => {
  it("serializes operations that share the tracked browser tab", async () => {
    const { driver } = await startedDriver({ thread: {} });
    let active = 0;
    let maximumActive = 0;
    let firstEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondFinished = false;

    const first = driver.runExclusive(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      firstEntered();
      await firstMayFinish;
      active -= 1;
    });
    await entered;

    const second = driver.runExclusive(() => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
      secondFinished = true;
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(secondFinished).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  });
});

describe("PlaywrightAdviserDriver.selectModel", () => {
  const PICKER = 'button[aria-label*="model" i]';
  const OPTION = '[role="menuitem"]';

  it("will not let a page-derived model id address an element outside the model menu", async () => {
    // `listModels()` reports model ids read off the picker, and `consult()` hands one straight back to
    // `selectModel`, which builds a `:has-text("…")` selector from it. Unsanitized, an id like this closes
    // the string literal and the driver clicks whatever element the injected selector matches — the page
    // choosing what the extension clicks (INV-05).
    const thread: FakeThread = {
      [PICKER]: [node("GPT-5.5")],
      [OPTION]: [],
      // The element the injected selector would have matched.
      '[role="menuitem"]:has-text("x"):has-text("y")': [node("Log out of this device")],
    };
    const { clicked, driver } = await startedDriver({ thread });

    const selected = await driver.selectModel('x"):has-text("y');

    expect(selected).toBe(false);
    expect(clicked).not.toContain("Log out of this device");
  });

  it("refuses to click whatever an empty model id happens to match", async () => {
    // `:has-text("")` matches every option in the menu, so a degenerate id used to open the menu and click
    // its first entry before reporting failure. Reporting "could not select" must not cost a stray click.
    const thread: FakeThread = {
      [PICKER]: [node("GPT-5.5")],
      [OPTION]: [],
      '[role="menuitem"]:has-text("")': [node("First option in the menu")],
    };
    const { clicked, driver } = await startedDriver({ thread });

    const selected = await driver.selectModel("");

    expect(selected).toBe(false);
    expect(clicked).not.toContain("First option in the menu");
  });
});
