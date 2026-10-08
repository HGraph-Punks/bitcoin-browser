import type {Library} from './types';
export const researchKey=(id:string)=>'research-'+id;
export const needsLibraryWarning=(library:Library)=>!library.runtimeTested||!library.licenseReviewed;
