import { auth } from "../../utils/auth/auth";

export default defineEventHandler((event) => {
  return auth.handler(toWebRequest(event));
});
