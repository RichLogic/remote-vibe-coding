import '../../../core/json/json_helpers.dart';
import 'coding_models.dart';

class CodingWorkspaceMutationResult {
  const CodingWorkspaceMutationResult({
    required this.workspaceRoot,
    required this.workspaces,
    this.workspace,
  });

  final String workspaceRoot;
  final List<CodingWorkspace> workspaces;
  final CodingWorkspace? workspace;

  factory CodingWorkspaceMutationResult.fromJson(Map<String, dynamic> json) {
    return CodingWorkspaceMutationResult(
      workspaceRoot: readString(json, 'workspaceRoot'),
      workspaces: readObjectList(
        json,
        'workspaces',
        CodingWorkspace.fromJson,
      ),
      workspace: json['workspace'] == null
          ? null
          : CodingWorkspace.fromJson(asJsonMap(json['workspace'])),
    );
  }
}
