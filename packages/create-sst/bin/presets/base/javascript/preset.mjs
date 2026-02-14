import { extract, patch, install } from "create-sst";

export default [
  extract(),
  install({
    packages: ["sst@^2", "aws-cdk-lib@2.238.0", "constructs@10.4.5"],
    dev: true,
  }),
];
