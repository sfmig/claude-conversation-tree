/*
 * service-worker.js — minimal MV3 background worker.
 *
 * The content script does the bulk of the work and talks to chrome.storage
 * directly, so for Phase 1 the worker only logs lifecycle events. It exists now
 * so later phases (cross-tab coordination, popup ↔ content messaging) have a
 * home without a manifest change.
 */
"use strict";

chrome.runtime.onInstalled.addListener(function (details) {
  console.log("[CTV sw] installed:", details.reason);
});

chrome.runtime.onStartup.addListener(function () {
  console.log("[CTV sw] startup");
});
