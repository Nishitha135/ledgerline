\# LedgerLine – Secure Digital Banking and Transaction Ledger



\## 1. Introduction



LedgerLine is a secure digital banking and transaction ledger application designed to manage financial transactions while maintaining accuracy, consistency, and transparency.



The application supports account management, deposits, withdrawals, fund transfers, transaction statements, and audit operations. It focuses on preventing duplicate transactions, unauthorized access, incorrect balances, and concurrent transaction failures.



\## 2. Objectives



\- Develop a secure digital banking application.

\- Maintain accurate account balances.

\- Prevent duplicate transactions using idempotency keys.

\- Support secure deposits, withdrawals, and transfers.

\- Implement role-based access control.

\- Maintain an append-only transaction ledger.

\- Provide audit and reconciliation facilities.



\## 3. Technologies Used



\- \*\*Backend:\*\* Node.js, Express.js

\- \*\*Database:\*\* PostgreSQL

\- \*\*Frontend:\*\* HTML, CSS, JavaScript

\- \*\*Authentication:\*\* JWT

\- \*\*Password Security:\*\* bcrypt

\- \*\*Validation:\*\* Zod

\- \*\*Testing:\*\* Automated Node.js tests

\- \*\*Deployment:\*\* Render

\- \*\*Database Hosting:\*\* Neon PostgreSQL



\## 4. System Modules



\### 4.1 Authentication Module



Provides user registration, sign-in, and sign-out functionality. Passwords are securely hashed, and JWT-based authentication is used to authorize requests.



\### 4.2 Account Management



Supports account creation and account-related operations. Different permissions are provided based on user roles.



\### 4.3 Transaction Management



Supports:

\- Deposits

\- Withdrawals

\- Fund transfers

\- Transaction statements



\### 4.4 Idempotency Management



Uses the Idempotency-Key mechanism to prevent duplicate financial transactions when users retry requests or accidentally click buttons multiple times.



\### 4.5 Role-Based Access Control



The application supports three roles:



\- \*\*Holder:\*\* Can access authorized accounts and perform permitted transactions.

\- \*\*Admin:\*\* Can manage accounts and perform authorized administrative operations.

\- \*\*Auditor:\*\* Can view audit information and reconciliation results without performing money-moving operations.



\### 4.6 Audit and Reconciliation



Maintains records of refused transaction attempts and provides reconciliation checks to verify that account balances match ledger records.



\## 5. Security Features



\- JWT-based authentication.

\- bcrypt password hashing.

\- Role-based authorization.

\- Input validation using Zod.

\- PostgreSQL transactions.

\- Row-level locking using SELECT FOR UPDATE.

\- Advisory locks for idempotency.

\- Double-entry accounting.

\- Append-only ledger protections.

\- Database constraints for overdraft protection.

\- Rate limiting for login and registration.

\- Least-privilege database access.

\- Automated security and concurrency tests.



\## 6. Testing and Validation



Automated tests are used to validate transaction correctness, concurrency handling, authorization, idempotency, input validation, audit operations, and database permissions.



Mutation testing is also used by removing selected security checks and verifying that relevant tests fail.



Manual verification is performed for important user interface flows, including authentication, transaction operations, and sign-out behavior.



\## 7. Advantages



\- Prevents duplicate transaction processing.

\- Maintains financial consistency.

\- Protects against unauthorized transactions.

\- Supports concurrent transaction handling.

\- Provides transaction transparency.

\- Helps identify inconsistencies through reconciliation.

\- Separates administrative and auditing permissions.



\## 8. Limitations and Future Enhancements



The current application does not implement:



\- Multi-currency transactions.

\- Scheduled and batch transfers.

\- Refunds and reversals.

\- Transaction holds and approval workflows.

\- Maker-checker approval for administrative deposits.

\- Automatic expiration of idempotency keys.



These features can be considered for future development.



\## 9. Conclusion



LedgerLine demonstrates how secure backend engineering, database transaction management, idempotency, role-based authorization, and double-entry accounting can be combined to build a reliable financial transaction application.



The project emphasizes financial correctness, security, transparency, and auditability while providing a foundation for future banking application enhancements.

