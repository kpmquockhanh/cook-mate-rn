// @ts-ignore
/// <reference types="nativewind/types" />

// NativeWind's stylesheet is pulled in for its side effect (`import
// './global.css'` in the root layouts). Metro handles it; TypeScript needs to
// be told the module exists.
declare module '*.css';
