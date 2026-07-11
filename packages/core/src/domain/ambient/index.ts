// Ambient timeline pure logic (lifted from web services/ambient + .../timeline).
// Pure data transforms / types / scheduling math only — no React, no platform
// SDK, no storage. The SQLite store and the pipeline runtime stay in each app
// and import these.
export * from "./types";
export * from "./source";
export * from "./utils";
export * from "./normalize";
export * from "./envelope";
export * from "./sound-runs";
export * from "./motion-segments";
export * from "./runtime-lifecycle";
export * from "./narrative";
export * from "./speaker-transcript";
export * from "./timeline-store";
export * from "./sqlite-timeline-store";
export * from "./pipeline";
