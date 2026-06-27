import { Credentials } from './Credentials.js';

export class CurrentDateTime extends Credentials {
  constructor() {
    super();
    this.DeviceDateTime = null;
  }
}
