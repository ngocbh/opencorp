/** Where a browser without a session lands: HQ signs in only through `opencorp pair`. */
export default function SignIn() {
  return (
    <main class="mx-auto max-w-md p-8">
      <h1 class="text-lg font-semibold">Sign in to OpenCorp HQ</h1>
      <p class="mt-4">
        Run <code>opencorp pair</code> on the office machine. HQ never asks for your password here.
      </p>
      <p class="mt-2 text-sm text-neutral-500">
        Over SSH, <code>opencorp pair</code> prints the <code>ssh -N -L</code> command to run first.
      </p>
    </main>
  )
}
