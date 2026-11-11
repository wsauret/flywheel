export interface Parcel {
  weightGrams: number;
  destinationPostcode: string;
}

export interface ReceiptLine {
  description: string;
  cents: number;
}
