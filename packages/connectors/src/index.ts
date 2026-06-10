/**
 * @donna/connectors — pluggable source connectors for email, chat, calendar,
 * and cloud storage, plus the demo dataset that powers credential-free demos.
 */
export * from './types.js';
export * from './registry.js';

// Demo dataset (Alex Chen @ Meridian Labs).
export * from './demo/dataset.js';

// Mock connectors (local, zero credentials).
export * from './mock/base.js';
export * from './mock/mock-email.js';
export * from './mock/mock-chat.js';
export * from './mock/mock-calendar.js';
export * from './mock/mock-storage.js';

// Google (env-driven hooks).
export * from './google/google-auth.js';
export * from './google/gmail.js';
export * from './google/google-calendar.js';
export * from './google/google-drive.js';

// Microsoft (env-driven hooks).
export * from './microsoft/ms-auth.js';
export * from './microsoft/outlook.js';
export * from './microsoft/teams.js';
export * from './microsoft/onedrive.js';

// Slack + AWS (env-driven hooks).
export * from './slack/slack.js';
export * from './aws/s3.js';

// Shared helpers.
export * from './util/parse.js';
