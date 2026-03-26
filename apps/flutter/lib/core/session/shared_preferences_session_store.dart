import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'session_store.dart';
import 'user_session.dart';

class SharedPreferencesSessionStore implements SessionStore {
  static const String _storageKey = 'rvc_flutter.session';

  @override
  Future<void> clear() async {
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    await preferences.remove(_storageKey);
  }

  @override
  Future<StoredSession?> load() async {
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    final String? raw = preferences.getString(_storageKey);
    if (raw == null || raw.isEmpty) {
      return null;
    }

    try {
      final dynamic decoded = jsonDecode(raw);
      if (decoded is! Map) {
        return null;
      }
      return StoredSession.fromJson(
        decoded.map((dynamic key, dynamic value) {
          return MapEntry(key.toString(), value);
        }),
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> save(StoredSession session) async {
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    await preferences.setString(
      _storageKey,
      jsonEncode(session.toJson()),
    );
  }
}
