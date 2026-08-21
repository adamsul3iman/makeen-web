declare namespace NodeJS {
  interface Process {
    /** Present when running inside a pkg-bundled executable. */
    pkg?: {
      entrypoint: string;
      path: string;
    };
  }
}
