#!/usr/bin/env node
/**
 * Merge all sessions from __architect__ and klaudii--iosapp into a single
 * session per workspace, interleaved by timestamp.
 *
 * Usage:  node scripts/merge-sessions.js [--dry-run]
 *
 * What it does:
 *   1. Reads every session history file for both workspaces
 *   2. Collects all messages, tagging each with its source session
 *   3. Sorts all messages by timestamp
 *   4. Writes the merged result as session 1 in each workspace
 *   5. Updates claude-chat-sessions.json to reflect a single session
 *   6. Backs up originals to a timestamped directory first
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const CONV_DIR = path.join(
  process.env.HOME,
  'Library/Application Support/com.klaudii.server/conversations'
);
const SESSIONS_FILE = path.join(__dirname, '..', 'claude-chat-sessions.json');

const WORKSPACES = ['__architect__', 'klaudii--iosapp'];

function loadHistory(workspace, sessionNum) {
  const file = path.join(CONV_DIR, workspace, 'claude-local', `${sessionNum}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getSessionFiles(workspace) {
  const dir = path.join(CONV_DIR, workspace, 'claude-local');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map(f => parseInt(f.replace('.json', ''), 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);
}

function main() {
  const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  const backupTag = new Date().toISOString().replace(/[:.]/g, '-');

  for (const workspace of WORKSPACES) {
    const sessionNums = getSessionFiles(workspace);
    console.log(`\n=== ${workspace} ===`);
    console.log(`  Found sessions: ${sessionNums.join(', ')}`);

    if (sessionNums.length <= 1) {
      console.log('  Only one session, nothing to merge.');
      continue;
    }

    // Collect all messages from all sessions
    let allMessages = [];
    for (const num of sessionNums) {
      const msgs = loadHistory(workspace, num);
      console.log(`  Session ${num}: ${msgs.length} messages`);
      allMessages.push(...msgs);
    }

    // Sort by timestamp (stable sort preserves order for same-ts messages)
    allMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));

    // Deduplicate: remove messages with identical ts + role + content
    const seen = new Set();
    const deduped = [];
    for (const msg of allMessages) {
      const key = `${msg.ts}|${msg.role}|${(msg.content || '').slice(0, 200)}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(msg);
      }
    }

    const removed = allMessages.length - deduped.length;
    console.log(`  Total: ${allMessages.length} messages, ${removed} duplicates removed`);
    console.log(`  Merged: ${deduped.length} messages`);

    if (DRY_RUN) {
      console.log('  [DRY RUN] Would write merged session and back up originals.');
      continue;
    }

    // Back up originals
    const backupDir = path.join(CONV_DIR, workspace, `claude-local-backup-${backupTag}`);
    const sourceDir = path.join(CONV_DIR, workspace, 'claude-local');
    fs.mkdirSync(backupDir, { recursive: true });
    for (const num of sessionNums) {
      const src = path.join(sourceDir, `${num}.json`);
      const dst = path.join(backupDir, `${num}.json`);
      fs.copyFileSync(src, dst);
    }
    console.log(`  Backed up ${sessionNums.length} files to ${path.basename(backupDir)}/`);

    // Write merged as session 1
    const mergedFile = path.join(sourceDir, '1.json');
    const tmpFile = mergedFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(deduped, null, 2));
    fs.renameSync(tmpFile, mergedFile);

    // Remove old session files (except 1.json which we just wrote)
    for (const num of sessionNums) {
      if (num === 1) continue;
      const old = path.join(sourceDir, `${num}.json`);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    console.log(`  Removed ${sessionNums.length - 1} old session files.`);

    // Update sessions metadata
    if (sessions[workspace]) {
      const oldSessions = sessions[workspace].sessions || {};
      // Keep the first session UUID if it exists
      const firstUuid = oldSessions['1'] || Object.values(oldSessions)[0] || null;
      sessions[workspace].current = 1;
      sessions[workspace].sessions = firstUuid ? { '1': firstUuid } : {};
      // Merge all taskIds into session 1
      if (sessions[workspace].taskIds) {
        const allTaskIds = [];
        for (const ids of Object.values(sessions[workspace].taskIds)) {
          allTaskIds.push(...ids);
        }
        sessions[workspace].taskIds = allTaskIds.length ? { '1': [...new Set(allTaskIds)] } : {};
      }
    }
  }

  if (!DRY_RUN) {
    // Write updated sessions file
    const tmpSessions = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmpSessions, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmpSessions, SESSIONS_FILE);
    console.log('\nUpdated claude-chat-sessions.json');
  }

  console.log('\nDone!');
}

main();
