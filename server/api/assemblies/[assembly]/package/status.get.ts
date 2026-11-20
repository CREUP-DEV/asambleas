import { defineEventHandler } from "h3";
import type { AssemblyPackageStatusDto } from "~~/shared/types/api";
import {
  packageNotPublic,
  resolvePackageRequest,
} from "../../../../utils/export/package/http";
import {
  packagePartStatus,
  packageStatus,
} from "../../../../utils/export/package/service";

/**
 * Whether the documentation package can be downloaded, is being built or
 * failed (`?locale=es&editable=1`, and `&filter=` for a part asked for
 * before). Polled while it builds: it reads a plan kept in memory until the
 * assembly changes, and a small file (a part, whether its pieces are there).
 */
export default defineEventHandler(
  async (event): Promise<AssemblyPackageStatusDto> => {
    const request = await resolvePackageRequest(event);
    const status = request.filter
      ? await packagePartStatus(
          request.assemblyId,
          request.locale,
          request.editable,
          request.filter,
        )
      : await packageStatus(
          request.assemblyId,
          request.locale,
          request.editable,
        );
    if (!status) packageNotPublic();
    return status;
  },
);
