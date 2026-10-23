import { describe, expect, it } from "vitest";
import { type FeedViewer, ScreenFeeds, stillFrame } from "./feed.js";
import type { Frame } from "./frames.js";

function feeds() {
  const subscriptions: Array<{
    slot: number;
    onFrame(frame: Frame): void;
    closed: boolean;
    fulls: number;
  }> = [];
  const subject = new ScreenFeeds(
    {
      frames(slot, _options, handlers) {
        const subscription = { slot, onFrame: handlers.onFrame, closed: false, fulls: 0 };
        subscriptions.push(subscription);
        return {
          requestFull: () => {
            subscription.fulls++;
          },
          close: () => {
            subscription.closed = true;
          },
        };
      },
    },
    { fps: 30, quality: 0.6 },
  );
  return { subject, subscriptions };
}

function viewer() {
  const frames: Frame[] = [];
  const each: FeedViewer & { frames: Frame[] } = {
    frames,
    frame: (frame) => frames.push(frame),
    close: () => undefined,
  };
  return each;
}

const live: Frame = {
  header: { seq: 1, width: 1280, height: 800, full: true, rects: [] },
  rects: [],
};

describe("ScreenFeeds", () => {
  it("shows the last frame of a sleeping screen without capturing it", () => {
    const { subject, subscriptions } = feeds();
    const still = stillFrame(Buffer.from("jpeg"), 1280, 800);
    expect(still.header).toEqual({
      seq: 0,
      width: 1280,
      height: 800,
      full: true,
      rects: [{ x: 0, y: 0, width: 1280, height: 800, size: 4 }],
    });
    subject.sleep(0, still);
    const watcher = viewer();
    subject.attach(0, watcher);
    subject.requestFull(0);
    expect(watcher.frames).toEqual([still, still]);
    expect(subscriptions).toEqual([]);
  });

  it("stops capturing when a watched screen sleeps and resumes when it wakes", () => {
    const { subject, subscriptions } = feeds();
    const watcher = viewer();
    subject.attach(0, watcher);
    subscriptions[0]!.onFrame(live);
    const still = stillFrame(Buffer.from("jpeg"), 1280, 800);
    subject.sleep(0, still);
    expect(subscriptions[0]!.closed).toBe(true);
    expect(watcher.frames).toEqual([live, still]);
    subject.wake(0);
    expect(subscriptions).toHaveLength(2);
    subscriptions[1]!.onFrame(live);
    expect(watcher.frames).toEqual([live, still, live]);
  });

  it("captures again only for screens that have viewers", () => {
    const { subject, subscriptions } = feeds();
    subject.sleep(1, stillFrame(Buffer.from("jpeg"), 1280, 800));
    subject.wake(1);
    expect(subscriptions).toEqual([]);
    subject.attach(1, viewer());
    expect(subscriptions.map(({ slot }) => slot)).toEqual([1]);
  });
});
