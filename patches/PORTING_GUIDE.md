# Patch Porting Guide

Step-by-step instructions for porting patches when upgrading `@google/gemini-cli-core`.

## When You Need This

After running `npm install` or upgrading gemini-cli packages, you'll see one of:

1. **patch-package warning**: "patch was made for version X but installed version is Y"
2. **check-patches.js warning**: "UNVETTED PATCH VERSION"
3. **Test failure**: `patch-invariants.test.js` fails

## Patch #1: coreToolScheduler ask_user payload passthrough

### The Bug

`CoreToolScheduler.handleConfirmationResponse()` wraps each tool's `onConfirm` callback
but drops the `payload` parameter when calling it. This means `AskUserInvocation` never
receives the user's answers — `this.userAnswers` stays `{}` and the tool returns
"User submitted without answering questions" to the LLM.

### Where It Lives

```
node_modules/@google/gemini-cli-core/dist/src/core/coreToolScheduler.js
```

Class: `CoreToolScheduler`
Method: `handleConfirmationResponse(callId, originalOnConfirm, outcome, signal, payload)`

### How to Check if the Bug Still Exists

Open the file and search for `handleConfirmationResponse`. Find the line that calls
`originalOnConfirm`. It will look like one of these:

```js
// BUGGY — only passes outcome, drops payload:
await originalOnConfirm(outcome);

// FIXED — passes both:
await originalOnConfirm(outcome, payload);
```

If it says `originalOnConfirm(outcome)` without `payload`, the bug still exists.

You can also verify programmatically:

```bash
grep -n "originalOnConfirm(outcome)" \
  node_modules/@google/gemini-cli-core/dist/src/core/coreToolScheduler.js
```

If this returns a match, the bug is present. If it returns nothing, check if
`originalOnConfirm(outcome, payload)` exists instead — that means it's fixed upstream.

### How to Apply the Fix

```bash
# 1. Open the file
code node_modules/@google/gemini-cli-core/dist/src/core/coreToolScheduler.js

# 2. Find this line (in handleConfirmationResponse):
await originalOnConfirm(outcome);

# 3. Change it to:
await originalOnConfirm(outcome, payload);

# 4. Save the file

# 5. Create the patch:
npx patch-package @google/gemini-cli-core

# 6. Update registry.json — add the new version to the "vetted" array:
#    "vetted": ["0.32.1", "0.33.0"]

# 7. Run the invariant test to verify:
npx vitest run test/unit/patch-invariants.test.js

# 8. Commit the new .patch file and updated registry.json
```

### Why This Fix Works

The call chain is:

1. LLM emits `ask_user` tool call with `questions` array
2. `CoreToolScheduler` creates an `AskUserInvocation` and calls `shouldConfirmExecute()`
3. Invocation returns `confirmationDetails` with an `onConfirm(outcome, payload)` callback
4. Scheduler wraps it: `onConfirm → handleConfirmationResponse → originalOnConfirm`
5. Our code (`gemini-core.js confirmToolCall`) calls `details.onConfirm(outcome, {answers: {...}})`
6. The wrapper calls `handleConfirmationResponse(callId, originalOnConfirm, outcome, signal, payload)`
7. **BUG**: `handleConfirmationResponse` calls `originalOnConfirm(outcome)` — drops `payload`
8. `AskUserInvocation.onConfirm` receives `(outcome, undefined)` — `this.userAnswers` stays `{}`
9. `execute()` returns `"User submitted without answering questions"` to the LLM

The one-line fix at step 7 passes `payload` through, so the answers reach the invocation.

### The AskUserInvocation.onConfirm callback (for reference)

```js
// In node_modules/@google/gemini-cli-core/dist/src/tools/ask-user.js
onConfirm: async (outcome, payload) => {
    this.confirmationOutcome = outcome;
    if (payload && 'answers' in payload) {
        this.userAnswers = payload.answers;
    }
},
```

### Related Files in Klaudii

- `lib/gemini-core.js` — `confirmToolCall()` builds the payload and calls `details.onConfirm`
- `public/chat.js` — `chatShowToolQuestions()` collects user answers, `chatConfirmTool()` sends them
- `server.js` — `/api/gemini/:workspace/confirm` endpoint proxies answer to gemini-core

### Automated Verification

The invariant test at `test/unit/patch-invariants.test.js` greps the source file to ensure
the fix is present. If it fails, follow the steps above.
