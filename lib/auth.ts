export type VitalRole = "doctor" | "staff";

export const DEMO_HOSPITAL_ID = "vital-demo-hospital";
export const DEMO_HOSPITAL_NAME = "VITAL Demo Hospital";

export const ACCESS_RESTRICTED_MESSAGE =
  "Access restricted. Please consult your supervising physician.";

export const AI_ASSISTANT_RESTRICTED_MESSAGE =
  "AI assistant access is restricted to doctors in this demo.";

export const API_AI_RESTRICTED_MESSAGE =
  "AI assistant access is restricted to doctors.";

export const INVALID_DOCTOR_LOGIN_MESSAGE =
  "Invalid doctor name or ID. Please try again.";

export const INVALID_STAFF_LOGIN_MESSAGE =
  "Invalid staff name or ID. Please try again.";

export type VitalUser = {
  userId: string;
  userName: string;
  role: VitalRole;
  doctorId?: string;
  staffId?: string;
  hospitalId: string;
  hospitalName: string;
};

export type DemoDoctorAccount = {
  userName: string;
  doctorId: string;
  role: "doctor";
};

/** Demo-only credentials — not production security. */
export const DEMO_DOCTOR_ACCOUNTS: DemoDoctorAccount[] = [
  { userName: "Eknoor Sidhu", doctorId: "74321", role: "doctor" },
  { userName: "Ashir Ahmed", doctorId: "98768", role: "doctor" },
];

export type DemoStaffAccount = {
  userName: string;
  staffId: string;
  role: "staff";
};

/** Demo-only credentials — not production security. */
export const DEMO_STAFF_ACCOUNTS: DemoStaffAccount[] = [
  { userName: "Gurdit Johal", staffId: "54321", role: "staff" },
];

export type VitalPermissions = {
  canUseAI: boolean;
  canAdmitPatient: boolean;
  canDischargePatient: boolean;
  canEditPatientStatus: boolean;
  canCreateMedicationOrders: boolean;
  canViewReports: boolean;
  canViewAnalytics: boolean;
  canViewSettings: boolean;
};

export function normalizePersonName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeCredentialId(id: string): string {
  return id.trim();
}

/** @deprecated Use normalizePersonName */
export const normalizeDoctorName = normalizePersonName;

/** @deprecated Use normalizeCredentialId */
export const normalizeDoctorId = normalizeCredentialId;

export function findDemoDoctor(
  fullName: string,
  doctorId: string
): DemoDoctorAccount | null {
  const normalizedName = normalizePersonName(fullName);
  const normalizedId = normalizeCredentialId(doctorId);
  if (!normalizedName || !normalizedId) return null;
  return (
    DEMO_DOCTOR_ACCOUNTS.find(
      (account) =>
        normalizePersonName(account.userName) === normalizedName &&
        normalizeCredentialId(account.doctorId) === normalizedId
    ) ?? null
  );
}

export function findDemoStaff(
  fullName: string,
  staffId: string
): DemoStaffAccount | null {
  const normalizedName = normalizePersonName(fullName);
  const normalizedId = normalizeCredentialId(staffId);
  if (!normalizedName || !normalizedId) return null;
  return (
    DEMO_STAFF_ACCOUNTS.find(
      (account) =>
        normalizePersonName(account.userName) === normalizedName &&
        normalizeCredentialId(account.staffId) === normalizedId
    ) ?? null
  );
}

export function buildDoctorUser(account: DemoDoctorAccount): VitalUser {
  return {
    userId: `doctor-${account.doctorId}`,
    userName: account.userName,
    role: "doctor",
    doctorId: account.doctorId,
    hospitalId: DEMO_HOSPITAL_ID,
    hospitalName: DEMO_HOSPITAL_NAME,
  };
}

export function buildStaffUser(account: DemoStaffAccount): VitalUser {
  return {
    userId: `staff-${account.staffId}`,
    userName: account.userName,
    role: "staff",
    staffId: account.staffId,
    hospitalId: DEMO_HOSPITAL_ID,
    hospitalName: DEMO_HOSPITAL_NAME,
  };
}

export function formatDoctorDisplayName(userName: string): string {
  return `Dr. ${userName}`;
}

export function isVitalUser(value: unknown): value is VitalUser {
  if (!value || typeof value !== "object") return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.userId === "string" &&
    typeof u.userName === "string" &&
    (u.role === "doctor" || u.role === "staff") &&
    typeof u.hospitalId === "string" &&
    typeof u.hospitalName === "string" &&
    (u.doctorId === undefined || typeof u.doctorId === "string") &&
    (u.staffId === undefined || typeof u.staffId === "string")
  );
}

export function getPermissions(role: VitalRole | null): VitalPermissions {
  const isDoctor = role === "doctor";
  return {
    canUseAI: isDoctor,
    canAdmitPatient: isDoctor,
    canDischargePatient: isDoctor,
    canEditPatientStatus: isDoctor,
    canCreateMedicationOrders: isDoctor,
    canViewReports: isDoctor,
    canViewAnalytics: isDoctor,
    canViewSettings: isDoctor,
  };
}

export function parseRole(raw: unknown): VitalRole | null {
  return raw === "doctor" || raw === "staff" ? raw : null;
}

export function parseRoleFromRequest(
  req: Request,
  bodyRole?: unknown
): VitalRole | null {
  const headerRole = req.headers.get("x-vital-role");
  const fromHeader = parseRole(headerRole);
  if (fromHeader) return fromHeader;
  return parseRole(bodyRole);
}

export function roleRequestHeaders(role: VitalRole | null): HeadersInit {
  if (!role) return {};
  return { "x-vital-role": role };
}

export function isRestrictedClinicalPatch(patch: unknown): boolean {
  if (!patch || typeof patch !== "object") return false;
  const keys = Object.keys(patch as Record<string, unknown>);
  return keys.some((k) =>
    ["problems", "edOrUrgentCourse", "triageAcuity", "chiefConcern"].includes(k)
  );
}

export const DOCTOR_ONLY_API_MESSAGE =
  "This action is restricted to doctors in this demo.";
