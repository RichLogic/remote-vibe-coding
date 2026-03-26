Map<String, dynamic> asJsonMap(dynamic value) {
  if (value is Map<String, dynamic>) {
    return value;
  }
  if (value is Map) {
    return value.map((key, dynamic entry) {
      return MapEntry(key.toString(), entry);
    });
  }
  throw FormatException('Expected JSON object but found ${value.runtimeType}.');
}

List<dynamic> asJsonList(dynamic value) {
  if (value is List<dynamic>) {
    return value;
  }
  if (value is List) {
    return List<dynamic>.from(value);
  }
  return const [];
}

String readString(
  Map<String, dynamic> json,
  String key, {
  String fallback = '',
}) {
  final dynamic value = json[key];
  return value is String ? value : fallback;
}

String? readNullableString(Map<String, dynamic> json, String key) {
  final dynamic value = json[key];
  if (value is String && value.trim().isNotEmpty) {
    return value;
  }
  return null;
}

bool readBool(
  Map<String, dynamic> json,
  String key, {
  bool fallback = false,
}) {
  final dynamic value = json[key];
  return value is bool ? value : fallback;
}

int readInt(
  Map<String, dynamic> json,
  String key, {
  int fallback = 0,
}) {
  final dynamic value = json[key];
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.toInt();
  }
  return fallback;
}

List<String> readStringList(Map<String, dynamic> json, String key) {
  return asJsonList(json[key]).whereType<String>().toList(growable: false);
}

List<T> readObjectList<T>(
  Map<String, dynamic> json,
  String key,
  T Function(Map<String, dynamic> value) fromJson,
) {
  return asJsonList(json[key])
      .map((dynamic item) => fromJson(asJsonMap(item)))
      .toList(growable: false);
}

