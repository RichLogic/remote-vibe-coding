import 'user_session.dart';

abstract class SessionStore {
  Future<StoredSession?> load();

  Future<void> save(StoredSession session);

  Future<void> clear();
}

class InMemorySessionStore implements SessionStore {
  StoredSession? _session;

  @override
  Future<void> clear() async {
    _session = null;
  }

  @override
  Future<StoredSession?> load() async {
    return _session;
  }

  @override
  Future<void> save(StoredSession session) async {
    _session = session;
  }
}

