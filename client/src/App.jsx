import { Navigate, Route, Routes } from 'react-router-dom'
import { PatientLayout, DashboardLayout } from './components/Layouts.jsx'
import { Forbidden, NotFound, RequireRole } from './components/Guards.jsx'
import { ForgotPasswordPage, LoginPage, SetPasswordPage, SignupPage, VerifyEmailPage } from './pages/AuthPages.jsx'
import Home from './pages/patient/Home.jsx'
import Doctors from './pages/patient/Doctors.jsx'
import DoctorProfile from './pages/patient/DoctorProfile.jsx'
import Book from './pages/patient/Book.jsx'
import My, { Rebook } from './pages/patient/My.jsx'
import AdminDashboard from './pages/admin/AdminDashboard.jsx'
import AdminDoctors from './pages/admin/AdminDoctors.jsx'
import AdminDepartments from './pages/admin/AdminDepartments.jsx'
import DoctorHome, { DoctorUpcoming } from './pages/doctor/DoctorHome.jsx'
import DoctorAvailability from './pages/doctor/DoctorAvailability.jsx'

const ADMIN_NAV = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/doctors', label: 'Doctors' },
  { to: '/admin/departments', label: 'Departments' }
]
const DOCTOR_NAV = [
  { to: '/doctor', label: 'Today', end: true },
  { to: '/doctor/appointments', label: 'Appointments' },
  { to: '/doctor/availability', label: 'Availability & leave' }
]

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/reset-password" element={<SetPasswordPage mode="reset" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      <Route path="/admin" element={<RequireRole role="admin"><DashboardLayout title="Admin" items={ADMIN_NAV} /></RequireRole>}>
        <Route index element={<AdminDashboard />} />
        <Route path="doctors" element={<AdminDoctors />} />
        <Route path="departments" element={<AdminDepartments />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
      <Route path="/doctor" element={<RequireRole role="doctor"><DashboardLayout title="Doctor" items={DOCTOR_NAV} /></RequireRole>}>
        <Route index element={<DoctorHome />} />
        <Route path="appointments" element={<DoctorUpcoming />} />
        <Route path="availability" element={<DoctorAvailability />} />
        <Route path="*" element={<Navigate to="/doctor" replace />} />
      </Route>

      <Route element={<PatientLayout />}>
        <Route index element={<Home />} />
        <Route path="/doctors" element={<Doctors />} />
        <Route path="/doctors/:id" element={<DoctorProfile />} />
        <Route path="/book" element={<Book />} />
        <Route path="/my" element={<RequireRole role="patient"><My /></RequireRole>} />
        <Route path="/my/rebook/:id" element={<RequireRole role="patient"><Rebook /></RequireRole>} />
        <Route path="/forbidden" element={<Forbidden />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
