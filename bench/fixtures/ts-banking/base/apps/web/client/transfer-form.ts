// Progressive enhancement for the transfer form. Served to browsers as
// /static/transfer-form.js (types are stripped at request time), and imported
// directly by unit tests. The server re-validates everything; this module only
// gives faster feedback.

export interface TransferFormInput {
  fromAccountId: string;
  toAccount: string;
  amount: string;
  memo: string;
}

export type TransferFormErrors = Partial<Record<keyof TransferFormInput, string>>;

const ACCOUNT_NUMBER = /^QM-\d{4}-\d{4}$/i;
const ACCOUNT_ID = /^acc_[A-Za-z0-9]{4,32}$/;

export function amountPattern(minorDigits: number): RegExp {
  return minorDigits === 0 ? /^\d{1,12}$/ : new RegExp(`^\\d{1,12}(\\.\\d{1,${minorDigits}})?$`);
}

export function validateTransferForm(input: TransferFormInput, minorDigits = 2): TransferFormErrors {
  const errors: TransferFormErrors = {};
  if (!input.fromAccountId) errors.fromAccountId = "Choose an account to send from";
  const to = input.toAccount.trim();
  if (!to) errors.toAccount = "Enter the destination account number";
  else if (!ACCOUNT_NUMBER.test(to) && !ACCOUNT_ID.test(to)) errors.toAccount = "Account numbers look like QM-1000-0000";
  else if (to === input.fromAccountId) errors.toAccount = "Choose a different destination account";
  const amount = input.amount.trim();
  if (!amount) errors.amount = "Enter an amount";
  else if (!amountPattern(minorDigits).test(amount)) errors.amount = "Enter a valid amount, for example 25.00";
  else if (Number(amount) <= 0) errors.amount = "Amount must be greater than zero";
  if (input.memo.length > 140) errors.memo = "Memo must be 140 characters or fewer";
  return errors;
}

function showErrors(form: HTMLFormElement, errors: TransferFormErrors): void {
  for (const node of Array.from(form.querySelectorAll(".field-error.client"))) node.remove();
  for (const [field, message] of Object.entries(errors)) {
    const input = form.elements.namedItem(field);
    if (!(input instanceof HTMLElement)) continue;
    const span = document.createElement("span");
    span.className = "field-error client";
    span.textContent = message ?? "";
    input.insertAdjacentElement("afterend", span);
  }
}

export function attach(form: HTMLFormElement): void {
  form.addEventListener("submit", (event) => {
    const data = new FormData(form);
    const select = form.elements.namedItem("fromAccountId");
    const currency = select instanceof HTMLSelectElement ? select.selectedOptions[0]?.dataset["currency"] : undefined;
    const errors = validateTransferForm(
      {
        fromAccountId: String(data.get("fromAccountId") ?? ""),
        toAccount: String(data.get("toAccount") ?? ""),
        amount: String(data.get("amount") ?? ""),
        memo: String(data.get("memo") ?? ""),
      },
      currency === "JPY" ? 0 : 2,
    );
    if (Object.keys(errors).length > 0) {
      event.preventDefault();
      showErrors(form, errors);
    }
  });
}

if (typeof document !== "undefined") {
  const form = document.getElementById("transfer-form");
  if (form instanceof HTMLFormElement) attach(form);
}
