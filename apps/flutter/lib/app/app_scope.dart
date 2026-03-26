import 'package:flutter/widgets.dart';

import '../core/files/attachment_picker.dart';
import '../core/session/session_controller.dart';
import '../features/coding/application/coding_controller.dart';

class AppScope extends InheritedWidget {
  const AppScope({
    required this.attachmentPicker,
    required this.sessionController,
    required this.codingController,
    required super.child,
    super.key,
  });

  final AttachmentPicker attachmentPicker;
  final SessionController sessionController;
  final CodingController codingController;

  static AppScope of(BuildContext context) {
    final AppScope? scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope is missing from the widget tree.');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) {
    return attachmentPicker != oldWidget.attachmentPicker ||
        sessionController != oldWidget.sessionController ||
        codingController != oldWidget.codingController;
  }
}
