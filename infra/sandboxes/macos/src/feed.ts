import type { DisplaydClient, FrameSubscription } from "./displayd.js";
import type { Frame } from "./frames.js";

export interface FeedViewer {
  frame(frame: Frame): void;
  close(): void;
}

export interface FeedOptions {
  fps: number;
  quality: number;
  onError?(slot: number, error: Error): void;
}

export function stillFrame(jpeg: Buffer, width: number, height: number): Frame {
  const rect = { x: 0, y: 0, width, height, size: jpeg.length };
  return {
    header: { seq: 0, width, height, full: true, rects: [rect] },
    rects: [{ ...rect, jpeg }],
  };
}

export class ScreenFeeds {
  private readonly feeds = new Map<number, ScreenFeed>();
  private readonly stills = new Map<number, Frame>();

  constructor(
    private readonly displayd: Pick<DisplaydClient, "frames">,
    private readonly options: FeedOptions,
  ) {}

  attach(slot: number, viewer: FeedViewer) {
    const feed = this.feeds.get(slot) ?? this.create(slot);
    feed.add(viewer);
    return () => feed.remove(viewer);
  }

  private create(slot: number) {
    const feed: ScreenFeed = new ScreenFeed(
      this.displayd,
      slot,
      this.options,
      () => {
        if (this.feeds.get(slot) === feed) this.feeds.delete(slot);
      },
      () => this.stills.get(slot),
    );
    this.feeds.set(slot, feed);
    return feed;
  }

  requestFull(slot: number) {
    this.feeds.get(slot)?.requestFull();
  }

  viewers(slot: number) {
    return this.feeds.get(slot)?.size ?? 0;
  }

  sleep(slot: number, still: Frame) {
    this.stills.set(slot, still);
    this.feeds.get(slot)?.pause();
  }

  wake(slot: number) {
    if (this.stills.delete(slot)) this.feeds.get(slot)?.resume();
  }

  close(slot: number) {
    this.stills.delete(slot);
    this.feeds.get(slot)?.closeAll();
  }
}

class ScreenFeed {
  private readonly viewers = new Set<FeedViewer>();
  private subscription?: FrameSubscription;

  constructor(
    private readonly displayd: Pick<DisplaydClient, "frames">,
    private readonly slot: number,
    private readonly options: FeedOptions,
    private readonly onEmpty: () => void,
    private readonly still: () => Frame | undefined,
  ) {}

  get size() {
    return this.viewers.size;
  }

  add(viewer: FeedViewer) {
    this.viewers.add(viewer);
    const still = this.still();
    if (still) {
      viewer.frame(still);
      return;
    }
    if (this.subscription) {
      this.subscription.requestFull();
      return;
    }
    this.subscribe();
  }

  pause() {
    this.subscription?.close();
    this.subscription = undefined;
    this.requestFull();
  }

  resume() {
    if (this.viewers.size && !this.subscription) this.subscribe();
  }

  private subscribe() {
    this.subscription = this.displayd.frames(
      this.slot,
      { fps: this.options.fps, quality: this.options.quality },
      {
        onFrame: (frame) => {
          for (const each of this.viewers) each.frame(frame);
        },
        onClose: (error) => {
          this.subscription = undefined;
          if (error) this.options.onError?.(this.slot, error);
          this.closeAll();
        },
      },
    );
  }

  remove(viewer: FeedViewer) {
    if (!this.viewers.delete(viewer) || this.viewers.size) return;
    this.subscription?.close();
    this.subscription = undefined;
    this.onEmpty();
  }

  requestFull() {
    const still = this.still();
    if (!still) {
      this.subscription?.requestFull();
      return;
    }
    for (const viewer of this.viewers) viewer.frame(still);
  }

  closeAll() {
    for (const viewer of [...this.viewers]) viewer.close();
    this.viewers.clear();
    this.subscription?.close();
    this.subscription = undefined;
    this.onEmpty();
  }
}
