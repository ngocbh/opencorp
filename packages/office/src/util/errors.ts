/** The text Python's `OSError.strerror` gives an error: C's `strerror` (macOS) for the errors file operations
 *  meet. The sandbox helper (`fs_helper.ts`) keeps a copy of this table, since the sandbox lets it load nothing
 *  but `node:` builtins; `tests/util/errors.test.ts` holds the two equal. */
import os from "node:os"
import util from "node:util"

/** C's `strerror` texts (macOS) for the errors file operations meet, as Python reports them. */
const STRERROR: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  EEXIST: "File exists",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
  EROFS: "Read-only file system",
  ENOSPC: "No space left on device",
  EIO: "Input/output error",
  EMFILE: "Too many open files",
  ENFILE: "Too many open files in system",
  ETXTBSY: "Text file busy",
  EBUSY: "Resource busy",
  EFBIG: "File too large",
  EINVAL: "Invalid argument",
  EILSEQ: "Illegal byte sequence",
  EDQUOT: "Disc quota exceeded",
  ESTALE: "Stale NFS file handle",
  EOPNOTSUPP: "Operation not supported on socket",
  ENOTSUP: "Operation not supported",
  EDEADLK: "Resource deadlock avoided",
  ENXIO: "Device not configured",
  ENOMEM: "Cannot allocate memory",
}

/** `error`'s errno and its text as Python's `OSError.strerror` gives it (C's `strerror` on macOS), or undefined
 *  when it isn't an OS error. A code the table lacks gets the runtime's text, capitalised as C's is. */
function systemError(error: unknown): { errno: number; text: string } | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const errnos: Record<string, number> = os.constants.errno
  if (!(error instanceof Error) || typeof code !== "string" || !Object.hasOwn(errnos, code)) return undefined
  const errno = errnos[code]!
  const libuv = util.getSystemErrorMessage(-errno)
  return { errno, text: STRERROR[code] ?? libuv.charAt(0).toUpperCase() + libuv.slice(1) }
}

/** `error`'s text as Python's `OSError.strerror` gives it, or undefined when it isn't an OS error. */
export function strerror(error: unknown): string | undefined {
  return systemError(error)?.text
}
