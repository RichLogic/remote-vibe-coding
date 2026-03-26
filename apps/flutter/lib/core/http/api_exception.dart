class ApiException implements Exception {
  const ApiException(
    this.message, {
    this.statusCode,
    this.body,
  });

  final String message;
  final int? statusCode;
  final dynamic body;

  @override
  String toString() => message;
}

