# Email Visual Tester Framework

[![GitHub Repository](https://img.shields.io/badge/GitHub-View%20Source-100000?style=for-the-badge&logo=github)](https://github.com/deptagency-dar/email-visual-tester)

### 🧐 What is This?

This framework automates **email visual regression testing**.

**Current Workflow:** The framework creates a test in our Email Testing Agent (currently **Email on Acid**) using a local **HTML file** you provide. It then uses the **Playwright Automation Test Framework** to automatically compare the resulting screenshots across various clients and devices against approved **Baseline Images**.

If the new image differs from the baseline, it generates a **Visual Comparison Heatmap** to show the exact pixels that changed, significantly speeding up QA sign-off.

---

### 🎯 Use Case: Quick Regression Check

Imagine you're testing an email, and you find a **bug** (like broken spacing in Outlook) in the first staging build. Development fixes the issue and sends a **second build**.

Instead of manually checking *all* clients again, you run the **Visual Testing Framework**. It instantly confirms:
1.  The bug is **fixed** in Outlook (the visual comparison fails as it finds some degreee of pixel diff).
2.  **No new bugs** were accidentally introduced to other clients like Gmail or Apple Mail (all other comparisons pass meaning no new issues were introduced).

This framework allows you to perform a full **visual regression check** in minutes.

---

### ⚙️ Setup and Configuration

This section covers the initial setup and the critical configuration steps required for every test run.

#### Prerequisites

1.  **Node.js:** Ensure you have the latest stable version of **Node.js** installed.
2.  **Access:** You need the **API Key** and **Account Password** for the Email Testing Agent (currently Email on Acid).
3.  **Clone the Repository:**
    ```bash
    git clone [https://github.com/deptagency-dar/email-visual-tester.git](https://github.com/deptagency-dar/email-visual-tester.git)
    cd email-visual-tester
    ```
4.  **Install Dependencies:**
    ```bash
    npm install
    ```

#### Configuration Steps (Critical)

You must configure the `.env` file and the email's HTML file before every test run.

1.  **Configure the `.env` File (Environment Variables):**
    * Find the configuration file (i.e., `.env` in the root folder).
    * **Email Agent Credentials:** Define the service and provide the required credentials.
        ```
      EMAIL_PREVIEW_SERVICE= # Options: 'emailonacid', 'litmus'

      EMAILONACID_API_KEY= # Your Email on Acid API Key
      EMAILONACID_ACCOUNT_PASSWORD= # Your Email on Acid Account Password
      EXISTING_EOA_TEST_ID= # Your Existing Email on Acid Test ID

      LITMUS_API_KEY= # Your Litmus API Key
      EXISTING_LITMUS_EMAIL_GUID= # Your Existing Litmus Email GUID
        ```
    * **Define the Task:** Set the **eBay Task Name** that corresponds to the email you are testing. The framework uses this to find the correct blueprint.
        ```
        TASK_NAME= # Your Task Name e.g., "EB-22872 Staging"
        ```

2.  **Place and Name the HTML File:**
    * Place the finalized HTML file into the designated **`./emails`** folder.
    * The file **must** follow the standard **eBay Naming Convention**:
        * **Format:** `eb-(task number)-(staging)-(optional info).html`
        * **Examples:**
            * `eb-21397-staging.html`
            * `eb-19999-staging-ES.html`

---

### ▶️ How to Run the Tests

Once the framework is configured and the HTML file is correctly named, run the tests:

1.  **Execute the Automation:**
    * Open your terminal/command prompt inside the `email-visual-tester` folder.
    * Run the main test script:
        ```bash
        npm test
        ```

### 🖼️ Baseline Creation (First Run)

When running the tests for the very first time on a new email or a new client combination, the framework will execute a specific sequence:

1.  **Missing Baseline:** The comparison script will detect that the required baseline image does not exist.
2.  **Expected Failure:** The test for that specific client **will fail** because no comparison could be made.
3.  **Automatic Capture:** The framework will then **automatically save the newly rendered image** into the `/baselines` folder, naming it correctly.
4.  **Action:** You must then **rerun the test (`npm test`)** immediately. The second time, the comparison will succeed, assuming the new image matches the newly created baseline.

### 📊 Understanding the Output

After the tests complete, a folder (e.g., `/test-results` or `/reports`) will be created containing the outputs. The **Visual Comparison Heatmap** is the critical file for QA sign-off.

| Output File | Non-Technical Summary |
| :--- | :--- |
| **Test Report (HTML/JSON)** | The pass/fail scorecard for the entire test run. |
| **Visual Comparison Heatmap (PNG/JPEG)** | **The image that tells you *exactly* where the problem is.** Red/pink areas are differences. |

---

### 🚀 Future Enhancements and Next Steps

This framework is continuously being improved. Here are the key tasks planned and desirable goals for the next development cycles:

#### 1. Integration with Litmus (Planned Implementation)

The immediate goal is to complete the integration with the **Litmus** platform.

**Task:** Implement the `LitmusService` class, mirroring the structure of `email-on-acid-service.ts`.
* **Goal:** Once implemented, the framework will be configured to perform visual tests **directly on emails received by the Litmus service**, eliminating the need for **manual HTML file extraction** and local placement in the `./emails` folder. This streamlines the entire workflow.

#### 2. Better Reporting Tool (Desirable)

We would like to find a dedicated library to upgrade the current reporting into a more professional, interactive, and visually clear format.

* **Goal:** Provide a report that makes quick pass/fail assessment easier for the QA team, potentially by integrating with tools like Allure or Mochawesome.

#### 3. CI/CD Pipeline Integration (Desirable)

It is highly desirable to integrate this framework with a Continuous Integration/Continuous Deployment (CI/CD) pipeline.

* **Goal:** Automatically run visual tests whenever new email HTML is checked in. This ensures tests are triggered automatically, reducing manual effort and enabling instant visual feedback.
