import { QueryParameterBag } from "@aws-sdk/types";

export const queryStringToQueryParameterBag = (
  queryString: string
): QueryParameterBag => {
  if (!queryString) {
    return {};
  }

  const query: QueryParameterBag = {};
  const searchParams = new URLSearchParams(queryString);
  
  for (const [key, value] of searchParams.entries()) {
    const decodedKey = decodeURIComponent(key);
    const decodedValue = decodeURIComponent(value);

    if (query[decodedKey] === undefined) {
      query[decodedKey] = decodedValue;
    } else if (Array.isArray(query[decodedKey])) {
      (query[decodedKey] as string[]).push(decodedValue);
    } else {
      query[decodedKey] = [query[decodedKey] as string, decodedValue];
    }
  }

  return query;
};
