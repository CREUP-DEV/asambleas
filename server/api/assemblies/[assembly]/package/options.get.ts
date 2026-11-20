import { defineEventHandler } from "h3";
import type { PackageOptionsDto } from "~~/shared/types/api";
import {
  packageNotPublic,
  resolvePackageRequest,
} from "../../../../utils/export/package/http";
import { packageOptions } from "../../../../utils/export/package/service";

/**
 * What the documentation package's filters offer (the documents by agenda
 * item, their amendments and who signs them), as the public reads it: the
 * same for everyone, from the package's own source, kept in memory until
 * the assembly changes.
 */
export default defineEventHandler(async (event): Promise<PackageOptionsDto> => {
  const request = await resolvePackageRequest(event);
  const options = await packageOptions(request.assemblyId);
  if (!options) packageNotPublic();
  return options;
});
