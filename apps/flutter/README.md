# Flutter Coding Client

This directory contains the Flutter-side mobile client for `remote-vibe-coding`.

Current scope:

- no backend changes
- mobile coding client
- direct reuse of the current host HTTP API
- token-based auth flow for mobile
- coding only

Current assumptions:

- the host already accepts `Authorization: Bearer <token>`
- mobile users paste a host URL and personal token manually
- native iOS/Android shell folders are not generated yet in this repo

Why the native shells are missing:

- the current workspace does not have the Flutter SDK installed
- this pass focuses on app architecture and Dart code layout first

Suggested next steps on a machine with Flutter installed:

```bash
cd apps/flutter
flutter create .
flutter pub get
flutter run
```

Current structure:

- `lib/core`
  shared HTTP, JSON, and session primitives
- `lib/features/auth`
  token login flow
- `lib/features/coding`
  coding bootstrap, workspace management, session settings, attachments, approvals, transcript, commands, changes
- `lib/features/home`
  coding-first mobile shell

Implemented before Flutter/host joint testing:

- token auth and session restore
- coding bootstrap and polling refresh
- workspace selection, creation, visibility toggle, reorder
- session creation, settings update, restart, fork, archive, restore, delete
- draft attachment upload and removal
- prompt send with optional attachments
- approval actions
- transcript, command, change, and live-event views

Known limitations:

- session persistence is local `shared_preferences`, not secure storage yet
- push notifications are not wired yet
- native platform folders must be generated later with Flutter tooling
- this machine does not have `flutter` or `dart`, so the code has not been compiled locally yet
