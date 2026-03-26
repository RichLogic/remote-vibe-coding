import '../json/json_helpers.dart';

class StoredSession {
  const StoredSession({
    required this.hostUrl,
    required this.token,
  });

  final String hostUrl;
  final String token;

  StoredSession copyWith({
    String? hostUrl,
    String? token,
  }) {
    return StoredSession(
      hostUrl: hostUrl ?? this.hostUrl,
      token: token ?? this.token,
    );
  }

  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'hostUrl': hostUrl,
      'token': token,
    };
  }

  factory StoredSession.fromJson(Map<String, dynamic> json) {
    return StoredSession(
      hostUrl: readString(json, 'hostUrl'),
      token: readString(json, 'token'),
    );
  }
}

class AuthenticatedUser {
  const AuthenticatedUser({
    required this.id,
    required this.username,
    required this.roles,
    required this.allowedSessionTypes,
    required this.isAdmin,
    required this.canUseFullHost,
    required this.preferredMode,
  });

  final String id;
  final String username;
  final List<String> roles;
  final List<String> allowedSessionTypes;
  final bool isAdmin;
  final bool canUseFullHost;
  final String? preferredMode;

  factory AuthenticatedUser.fromJson(Map<String, dynamic> json) {
    return AuthenticatedUser(
      id: readString(json, 'id'),
      username: readString(json, 'username'),
      roles: readStringList(json, 'roles'),
      allowedSessionTypes: readStringList(json, 'allowedSessionTypes'),
      isAdmin: readBool(json, 'isAdmin'),
      canUseFullHost: readBool(json, 'canUseFullHost'),
      preferredMode: readNullableString(json, 'preferredMode'),
    );
  }
}

