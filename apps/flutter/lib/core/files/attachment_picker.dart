import 'dart:typed_data';

class AttachmentUploadInput {
  const AttachmentUploadInput({
    required this.filename,
    required this.bytes,
    required this.mimeType,
  });

  final String filename;
  final Uint8List bytes;
  final String mimeType;
}

abstract class AttachmentPicker {
  Future<List<AttachmentUploadInput>> pickAttachments();
}
