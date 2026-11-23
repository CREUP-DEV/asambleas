import { createError, defineEventHandler, readBody } from "h3";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type { AssemblyPackageStatusDto } from "~~/shared/types/api";
import { db } from "../../../../db";
import { recordAudit } from "../../../../utils/domain/audit";
import {
  packageFilterAudit,
  packageNotPublic,
  resolvePackageRequest,
} from "../../../../utils/export/package/http";
import {
  rememberPackageFilter,
  requestPackage,
  requestPackagePart,
} from "../../../../utils/export/package/service";

/**
 * Asks for the assembly's documentation package: a ZIP with the
 * convocatoria, the agenda and a folder per item with its published
 * documents (PDF, and the Word version of each text with `editable`) and
 * their published amendments on CREUP's template. Any account that sees the
 * assembly may ask: the package is the same for everyone, built from what
 * is public. It is built once per state of the assembly, in the background
 * (package/build.ts); asking while it is current or being built only
 * answers the status. With `selection`, a part of it (some documents, some
 * amendments), zipped from the same pieces as it is downloaded: the answer
 * carries the key its status and download take (`part.key`). Recorded as
 * `export.request`.
 */
export default defineEventHandler(
  async (event): Promise<AssemblyPackageStatusDto> => {
    const request = await resolvePackageRequest(
      event,
      (await readBody(event)) ?? {},
    );
    await recordAudit(db, {
      event,
      actor: request.actor,
      action: AUDIT_ACTIONS.EXPORT_REQUEST,
      targetType: "assembly",
      targetId: request.assemblyId,
      assemblyId: request.assemblyId,
      after: {
        package: true,
        locale: request.locale,
        editable: request.format.editable,
        justified: request.format.justified,
        part: packageFilterAudit(request.filter),
      },
    });
    let status: AssemblyPackageStatusDto | null;
    try {
      if (request.filter) {
        rememberPackageFilter(request.assemblyId, request.filter);
        status = await requestPackagePart(
          request.assemblyId,
          request.locale,
          request.format,
          request.filter,
        );
      } else {
        status = await requestPackage(
          request.assemblyId,
          request.locale,
          request.format,
        );
      }
    } catch {
      throw createError({
        statusCode: 503,
        message: "No se pudo preparar la documentación",
      });
    }
    if (!status) packageNotPublic();
    return status;
  },
);
