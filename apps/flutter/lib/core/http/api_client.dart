import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import '../json/json_helpers.dart';
import '../session/user_session.dart';
import 'api_exception.dart';

String normalizeHostUrl(String rawHostUrl) {
  final String trimmed = rawHostUrl.trim();
  if (trimmed.isEmpty) {
    throw const ApiException('Host URL is required.');
  }
  final String withScheme = trimmed.contains('://') ? trimmed : 'http://$trimmed';
  final Uri parsed = Uri.parse(withScheme);
  final String normalized = parsed.toString().replaceFirst(RegExp(r'/+$'), '');
  return normalized;
}

class ApiClient {
  ApiClient(this.session);

  final StoredSession session;

  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, String?> query = const <String, String?>{},
  }) async {
    final dynamic response = await _request(
      'GET',
      path,
      query: query,
    );
    return asJsonMap(response);
  }

  Future<dynamic> postJson(
    String path, {
    Map<String, dynamic>? body,
    Map<String, String?> query = const <String, String?>{},
  }) {
    return _request(
      'POST',
      path,
      body: body,
      query: query,
    );
  }

  Future<dynamic> patchJson(
    String path, {
    Map<String, dynamic>? body,
  }) {
    return _request(
      'PATCH',
      path,
      body: body,
    );
  }

  Future<dynamic> deleteJson(String path) {
    return _request('DELETE', path);
  }

  Future<dynamic> postMultipartFile(
    String path, {
    required String fieldName,
    required String filename,
    required List<int> bytes,
    String mimeType = 'application/octet-stream',
  }) {
    final String boundary = '----rvc-${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 32)}';
    final BytesBuilder body = BytesBuilder();
    body.add(
      utf8.encode(
        '--$boundary\r\n'
        'Content-Disposition: form-data; name="${_escapeMultipartValue(fieldName)}"; filename="${_escapeMultipartValue(filename)}"\r\n'
        'Content-Type: $mimeType\r\n\r\n',
      ),
    );
    body.add(bytes);
    body.add(utf8.encode('\r\n--$boundary--\r\n'));

    return _request(
      'POST',
      path,
      bodyBytes: body.takeBytes(),
      contentType: 'multipart/form-data; boundary=$boundary',
    );
  }

  Uri _buildUri(
    String path,
    Map<String, String?> query,
  ) {
    final Uri base = Uri.parse('${normalizeHostUrl(session.hostUrl)}/');
    final String normalizedPath = path.startsWith('/') ? path.substring(1) : path;
    final Uri resolved = base.resolve(normalizedPath);
    final Map<String, String> nextQuery = <String, String>{
      ...resolved.queryParameters,
    };

    for (final MapEntry<String, String?> entry in query.entries) {
      final String? value = entry.value;
      if (value != null && value.isNotEmpty) {
        nextQuery[entry.key] = value;
      }
    }

    return resolved.replace(
      queryParameters: nextQuery.isEmpty ? null : nextQuery,
    );
  }

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    List<int>? bodyBytes,
    String? contentType,
    Map<String, String?> query = const <String, String?>{},
  }) async {
    final HttpClient client = HttpClient();
    try {
      final Uri uri = _buildUri(path, query);
      final HttpClientRequest request = await client.openUrl(method, uri);
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');

      if (session.token.trim().isNotEmpty) {
        request.headers.set(
          HttpHeaders.authorizationHeader,
          'Bearer ${session.token.trim()}',
        );
      }

      if (body != null && bodyBytes != null) {
        throw const ApiException('JSON body and byte body cannot be set together.');
      }

      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      } else if (bodyBytes != null) {
        if (contentType != null && contentType.isNotEmpty) {
          request.headers.set(HttpHeaders.contentTypeHeader, contentType);
        }
        request.add(bodyBytes);
      }

      final HttpClientResponse response = await request.close();
      final String responseText = await response.transform(utf8.decoder).join();
      final dynamic decoded = responseText.isEmpty ? null : jsonDecode(responseText);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        String message = '$method $path failed with status ${response.statusCode}';
        if (decoded is Map || decoded is Map<String, dynamic>) {
          final Map<String, dynamic> errorBody = asJsonMap(decoded);
          final String? apiMessage = readNullableString(errorBody, 'error');
          if (apiMessage != null) {
            message = apiMessage;
          }
        }
        throw ApiException(
          message,
          statusCode: response.statusCode,
          body: decoded,
        );
      }

      return decoded;
    } on SocketException {
      throw const ApiException('Could not reach the host service.');
    } on HttpException catch (error) {
      throw ApiException(error.message);
    } on FormatException catch (error) {
      throw ApiException('Invalid response format: ${error.message}');
    } finally {
      client.close(force: true);
    }
  }

  String _escapeMultipartValue(String value) {
    return value.replaceAll('"', '\\"');
  }
}
