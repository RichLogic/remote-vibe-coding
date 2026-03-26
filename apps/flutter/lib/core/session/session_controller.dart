import 'package:flutter/foundation.dart';

import '../http/api_client.dart';
import '../json/json_helpers.dart';
import 'session_store.dart';
import 'user_session.dart';

class SessionController extends ChangeNotifier {
  SessionController(this._store);

  final SessionStore _store;

  StoredSession? _session;
  AuthenticatedUser? _user;
  bool _restoring = true;
  bool _busy = false;
  String? _error;

  StoredSession? get session => _session;
  AuthenticatedUser? get user => _user;
  bool get restoring => _restoring;
  bool get busy => _busy;
  String? get error => _error;
  bool get isAuthenticated => _session != null && _user != null;

  Future<void> restore() async {
    _restoring = true;
    _error = null;
    notifyListeners();

    final StoredSession? savedSession = await _store.load();
    if (savedSession == null) {
      _restoring = false;
      notifyListeners();
      return;
    }

    try {
      await _authenticate(savedSession, persist: false);
    } catch (error) {
      await _store.clear();
      _session = null;
      _user = null;
      _error = 'Saved mobile session expired. Sign in again.';
    } finally {
      _restoring = false;
      notifyListeners();
    }
  }

  Future<void> signInWithToken({
    required String hostUrl,
    required String token,
  }) async {
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      await _authenticate(
        StoredSession(
          hostUrl: hostUrl,
          token: token,
        ),
        persist: true,
      );
    } catch (error) {
      _session = null;
      _user = null;
      _error = error.toString();
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<void> signOut() async {
    _session = null;
    _user = null;
    _error = null;
    await _store.clear();
    notifyListeners();
  }

  Future<void> _authenticate(
    StoredSession nextSession, {
    required bool persist,
  }) async {
    final StoredSession normalizedSession = nextSession.copyWith(
      hostUrl: normalizeHostUrl(nextSession.hostUrl),
      token: nextSession.token.trim(),
    );
    final ApiClient client = ApiClient(normalizedSession);
    final Map<String, dynamic> bootstrap = await client.getJson('/api/bootstrap');
    final AuthenticatedUser nextUser = AuthenticatedUser.fromJson(
      asJsonMap(bootstrap['currentUser']),
    );

    _session = normalizedSession;
    _user = nextUser;

    if (persist) {
      await _store.save(normalizedSession);
    }
  }
}

