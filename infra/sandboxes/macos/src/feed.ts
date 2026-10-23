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

export class ScreenFeeds {
  private readonly feeds = new Map<number, ScreenFeed>();

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
    const feed: ScreenFeed = new ScreenFeed(this.displayd, slot, this.options, () => {
      if (this.feeds.get(slot) === feed) this.feeds.delete(slot);
    });
    this.feeds.set(slot, feed);
    return feed;
  }

  requestFull(slot: number) {
    this.feeds.get(slot)?.requestFull();
  }

  viewers(slot: number) {
    return this.feeds.get(slot)?.size ?? 0;
  }

  close(slot: number) {
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
  ) {}

  get size() {
    return this.viewers.size;
  }

  add(viewer: FeedViewer) {
    this.viewers.add(viewer);
    if (this.subscription) {
      this.subscription.requestFull();
      return;
    }
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
    this.subscription?.requestFull();
  }

  closeAll() {
    for (const viewer of [...this.viewers]) viewer.close();
    this.viewers.clear();
    this.subscription?.close();
    this.subscription = undefined;
    this.onEmpty();
  }
}
