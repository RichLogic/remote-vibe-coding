import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';

import 'attachment_picker.dart';

class FilePickerAttachmentPicker implements AttachmentPicker {
  const FilePickerAttachmentPicker();

  @override
  Future<List<AttachmentUploadInput>> pickAttachments() async {
    final FilePickerResult? result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      withData: true,
    );
    if (result == null) {
      return const <AttachmentUploadInput>[];
    }

    final List<AttachmentUploadInput> attachments = <AttachmentUploadInput>[];
    for (final PlatformFile file in result.files) {
      final Uint8List? bytes = await _readBytes(file);
      if (bytes == null || bytes.isEmpty) {
        continue;
      }

      attachments.add(
        AttachmentUploadInput(
          filename: file.name,
          bytes: bytes,
          mimeType: _inferMimeType(file.name),
        ),
      );
    }
    return attachments;
  }

  Future<Uint8List?> _readBytes(PlatformFile file) async {
    final Uint8List? inMemory = file.bytes;
    if (inMemory != null && inMemory.isNotEmpty) {
      return inMemory;
    }

    final String? path = file.path;
    if (path == null || path.isEmpty) {
      return null;
    }

    final File localFile = File(path);
    if (!await localFile.exists()) {
      return null;
    }

    return localFile.readAsBytes();
  }

  String _inferMimeType(String filename) {
    final String lower = filename.toLowerCase();
    if (lower.endsWith('.png')) {
      return 'image/png';
    }
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (lower.endsWith('.gif')) {
      return 'image/gif';
    }
    if (lower.endsWith('.webp')) {
      return 'image/webp';
    }
    if (lower.endsWith('.pdf')) {
      return 'application/pdf';
    }
    if (lower.endsWith('.md')) {
      return 'text/markdown';
    }
    if (lower.endsWith('.txt') || lower.endsWith('.log')) {
      return 'text/plain';
    }
    if (lower.endsWith('.json')) {
      return 'application/json';
    }
    return 'application/octet-stream';
  }
}
