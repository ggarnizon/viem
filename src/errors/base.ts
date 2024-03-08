// Importing a utility function to get the version
import { getVersion } from './utils.js';

// Defining a type for parameters that can be passed to BaseError
type BaseErrorParameters = {
 docsPath?: string;
 docsSlug?: string;
 metaMessages?: string[];
} & (
 | {
      cause?: never;
      details?: string;
    }
 | {
      cause: BaseError | Error;
      details?: never;
    }
);

// Extending the Error class to create a custom error type
export class BaseError extends Error {
 details: string;
 docsPath?: string;
 metaMessages?: string[];
 shortMessage: string;

 // Overriding the name property to reflect the custom error type
 override name = 'ViemError';
 version = getVersion(); // Retrieving the version using the imported utility function

 constructor(shortMessage: string, args: BaseErrorParameters = {}) {
    super();

    // Determining the details of the error based on the cause or provided details
    const details =
      args.cause instanceof BaseError
        ? args.cause.details
        : args.cause?.message
          ? args.cause.message
          : args.details!;

    // Determining the docsPath based on the cause or provided docsPath
    const docsPath =
      args.cause instanceof BaseError
        ? args.cause.docsPath || args.docsPath
        : args.docsPath;

    // Constructing the error message with all available information
    this.message = [
      shortMessage || 'An error occurred.',
      '',
      ...(args.metaMessages ? [...args.metaMessages, ''] : []),
      ...(docsPath
        ? [`Docs: https://viem.sh${docsPath}${args.docsSlug ? `#${args.docsSlug}` : ''}`]
        : []),
      ...(details ? [`Details: ${details}`] : []),
      `Version: ${this.version}`,
    ].join('\n');

    // Assigning properties based on the provided arguments
    if (args.cause) this.cause = args.cause;
    this.details = details;
    this.docsPath = docsPath;
    this.metaMessages = args.metaMessages;
    this.shortMessage = shortMessage;
 }

 // Method to walk through the error chain, optionally applying a function to each error
 walk(): Error;
 walk(fn: (err: unknown) => boolean): Error | null;
 walk(fn?: any): any {
    // The walk function is used to traverse the error chain. It takes an optional function
    // that can be used to apply logic to each error in the chain.
    return walk(this, fn);
 }
}

// Utility function to walk through an error chain
function walk(err: unknown, fn?: (err: unknown) => boolean): unknown {
 // If a function is provided and it returns true for the current error, return the error.
 if (fn?.(err)) return err;
  
 // If the error is an object and has a 'cause' property, recursively walk through the cause.
 if (err && typeof err === 'object' && 'cause' in err)
    return walk(err.cause, fn);
  
 // If no function is provided or if the function does not return true for the current error,
 // return null or the error itself based on the presence of the function.
 return fn ? null : err;
}
