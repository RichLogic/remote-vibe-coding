import 'package:flutter/material.dart';

import 'app/app.dart';
import 'core/session/shared_preferences_session_store.dart';

void main() {
  runApp(
    RemoteVibeCodingApp(
      sessionStore: SharedPreferencesSessionStore(),
    ),
  );
}
